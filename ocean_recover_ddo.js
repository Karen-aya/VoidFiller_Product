require('dotenv').config();
const { ethers } = require('ethers');
const { ProviderInstance, Nft, ConfigHelper } = require('@oceanprotocol/lib');
const crypto = require('crypto');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const txHash = "0xa7d9d6c481d35a0aac4ffb431bd7219f57b7bd1a3b63dd98afe8fbb5ca514f12";
  const rpcUrl = process.env.RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const privateKey = process.env.OCEAN_PRIVATE_KEY || '0x1111111111111111111111111111111111111111111111111111111111111111';

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl, 137);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log("Fetching receipt for TX:", txHash);
  const receipt = await provider.getTransactionReceipt(txHash);

  if (!receipt) throw new Error("Receipt not found for " + txHash);

  let nftAddress = null;
  let datatokenAddress = null;

  const NFTCreatedTopic = '0x8125264ec1d174cb383ea0646ea1e6921ca3b0aba20370c8e18389e7c2d6a571';
  const TokenCreatedTopic = '0x567699dbf7c5f63a51a42fd451f5e065bca0dfc723adf2cc498bbb7cfb780b90';

  for (const log of receipt.logs) {
    if (log.topics[0] === NFTCreatedTopic) {
        nftAddress = ethers.utils.getAddress('0x' + log.data.substring(26, 66));
    }
    if (log.topics[0] === TokenCreatedTopic) {
        datatokenAddress = ethers.utils.getAddress('0x' + log.topics[1].substring(26, 66));
    }
  }

  if(!nftAddress || !datatokenAddress) {
      throw new Error("Could not find NFT or Datatoken address in the transaction logs.");
  }
  console.log("Found NFT Address:", nftAddress);
  console.log("Found Datatoken Address:", datatokenAddress);

  // Two distinct URIs:
  //  - localNodeUri: the ephemeral GitHub Actions node used for encryption only
  //  - publicProviderUri: the stable, externally reachable URI stored in the DDO and contract
  const localNodeUri   = 'http://127.0.0.1:8000';
  const publicProviderUri = 'https://v4.provider.polygon.oceanprotocol.com';

  let oceanConfig = new ConfigHelper().getConfig(137) || {};
  oceanConfig.network  = 'polygon';
  oceanConfig.chainId  = 137;
  oceanConfig.providerUri       = publicProviderUri;
  oceanConfig.metadataCacheUri  = localNodeUri; // local indexer for querying

  const chainIdHex = oceanConfig.chainId.toString(16);
  const didop = "did:op:" + crypto.createHash('sha256').update(nftAddress + chainIdHex).digest('hex');
  console.log("DID:", didop);

  // ---- Build file object (files encrypted against local node) ----
  const fileObj = [{ type: "url", url: "https://example.com/hosted/voidfiller_v1.jsonl", method: "GET" }];
  console.log("Encrypting files payload via local node...");
  const encryptedFiles = await ProviderInstance.encrypt(fileObj, oceanConfig.chainId, localNodeUri, wallet);

  // ---- Build strict DDO v4.1.0 ----
  const now = new Date().toISOString().replace(/\.[0-9]{3}/, '') + "Z";
  const serviceId = crypto.createHash('sha256').update("access" + datatokenAddress).digest('hex');

  const ddo = {
    "@context": ["https://w3id.org/did/v1"],
    id: didop,
    version: "4.1.0",
    chainId: oceanConfig.chainId,
    nftAddress: nftAddress,
    metadata: {
      created:     now,
      updated:     now,
      type:        "dataset",
      name:        "VoidFiller Audit Data",
      description: "EU AI Act 2026 Audit Data - VoidFiller",
      author:      "VoidFiller Agent",
      license:     "https://spdx.org/licenses/MIT.html"
    },
    services: [
      {
        id:              serviceId,
        type:            "access",
        files:           encryptedFiles,
        datatokenAddress: datatokenAddress,
        serviceEndpoint: publicProviderUri,  // ← Public, reachable endpoint (NOT localhost)
        timeout:         0
      }
    ]
  };

  // ---- Validate DDO structure against local node's indexer API ----
  console.log("\n--- DDO Validation ---");
  console.log("POSTing DDO to local node validate endpoint...");
  try {
    const ddoBytes = Buffer.from(JSON.stringify(ddo), 'utf8');
    const validateRes = await fetch(`${localNodeUri}/api/aquarius/assets/ddo/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: ddoBytes
    });
    const validateBody = await validateRes.text();
    console.log(`Validate HTTP status: ${validateRes.status}`);
    console.log(`Validate response: ${validateBody}`);
    if (validateRes.status !== 200) {
      console.warn("WARNING: DDO failed local validation. Inspect above response.");
    } else {
      console.log("DDO Validation: PASSED");
    }
  } catch(e) {
    console.warn("Could not reach local validate endpoint:", e.message);
  }

  // ---- Encrypt DDO against local node ----
  console.log("\nEncrypting DDO via local node...");
  const encryptedDDO = await ProviderInstance.encrypt(ddo, oceanConfig.chainId, localNodeUri, wallet);
  if (!encryptedDDO || !encryptedDDO.startsWith('0x')) {
    throw new Error("Provider encryption failed or did not return 0x string.");
  }
  console.log("Encryption success!");

  // ---- Hash MUST match exactly what Aquarius will expect ----
  const ddoString = JSON.stringify(ddo);
  const ddoHash   = "0x" + crypto.createHash('sha256').update(ddoString).digest('hex');
  console.log("DDO Hash:", ddoHash);

  // ---- setMetaData on chain ----
  console.log("\nSending setMetadata...");
  const nft         = new Nft(wallet, oceanConfig.network, oceanConfig);
  const nftContract = nft.getContract(nftAddress);

  const gasLimit  = process.env.GAS_LIMIT || '3000000';
  const maxFee    = process.env.MAX_FEE   || '200000000000';
  const prioFee   = process.env.PRIO_FEE  || '60000000000';

  const txOverrides = {
    gasLimit:            ethers.BigNumber.from(gasLimit).toString(),
    maxFeePerGas:        ethers.BigNumber.from(maxFee).toString(),
    maxPriorityFeePerGas: ethers.BigNumber.from(prioFee).toString()
  };

  const metaTxResponse = await nftContract.setMetaData(
    0,                // state: active
    publicProviderUri, // provider URL recorded on-chain (NOT localhost)
    '0x0000000000000000000000000000000000000000',
    '0x02',           // flags: encrypted
    encryptedDDO,
    ddoHash,
    [],
    txOverrides
  );

  console.log("Tx Sent! Hash:", metaTxResponse.hash || metaTxResponse.transactionHash);
  const finalMetaTxHash = metaTxResponse.hash || metaTxResponse.transactionHash;

  console.log("Waiting for on-chain confirmation...");
  const metaReceipt = await provider.waitForTransaction(finalMetaTxHash);
  if (metaReceipt.status === 0) {
    throw new Error("Transaction Reverted: " + finalMetaTxHash);
  }
  console.log("On-chain confirmed! Block:", metaReceipt.blockNumber);
  console.log(`\nMarketURL: https://market.oceanprotocol.com/asset/${didop}`);

  // ---- Poll local node indexer for indexing proof ----
  console.log("\nPolling local node indexer for DID indexing...");
  const localIndexUrl = `${localNodeUri}/api/aquarius/assets/ddo/${didop}`;
  let indexed   = false;
  const maxRetries = 30; // up to 5 minutes
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res  = await fetch(localIndexUrl);
      const body = await res.text();
      console.log(`[Indexer poll ${i+1}/${maxRetries}] HTTP ${res.status}`);
      if (res.status === 200) {
        console.log("SUCCESS: マーケットでの DID 検出を確認しました。");
        console.log("--- Indexer JSON Response ---");
        console.log(body);
        console.log("----------------------------");
        indexed = true;
        break;
      } else {
        console.log(`Response snippet: ${body.substring(0, 200)}`);
      }
    } catch (err) {
      console.log(`[Poll ${i+1}] Fetch error: ${err.message}`);
    }
    await sleep(10000);
  }

  if (!indexed) {
    console.error("FAIL: インデクサーが5分以内に DID を確認しませんでした。さらなる調査が必要です。");
    process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
