require('dotenv').config();

if (global.fetch) {
    delete global.fetch;
}

require('dotenv').config();
const { ethers } = require('ethers');

const { ethers } = require('ethers');
const { ProviderInstance, Nft, ConfigHelper } = require('@oceanprotocol/lib');
const crypto = require('crypto');

async function main() {
  const txHash = "0xa7d9d6c481d35a0aac4ffb431bd7219f57b7bd1a3b63dd98afe8fbb5ca514f12";
  const rpcUrl = process.env.RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const privateKey = process.env.OCEAN_PRIVATE_KEY || '0x1111111111111111111111111111111111111111111111111111111111111111';

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
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

  // Config context
  let oceanConfig = new ConfigHelper().getConfig(137) || {}; 
  oceanConfig.network = 'polygon';
  oceanConfig.chainId = 137;
  oceanConfig.providerUri = 'https://v4.provider.polygon.oceanprotocol.com';
  oceanConfig.metadataCacheUri = 'https://v4.aquarius.oceanprotocol.com';

  const chainIdHex = oceanConfig.chainId.toString(16);
  const didop = "did:op:" + crypto.createHash('sha256').update(nftAddress + chainIdHex).digest('hex');

  // Strict v4 DDO files encryption
  const fileObj = [
    {
      type: "url",
      url: "https://example.com/hosted/voidfiller_v1.jsonl",
      method: "GET"
    }
  ];
  console.log("Encrypting files payload...");
  const encryptedFiles = await ProviderInstance.encrypt(fileObj, oceanConfig.chainId, oceanConfig.providerUri, wallet);

  const ddo = {
      "@context": ["https://w3id.org/did/v1"],
      id: didop,
      version: "4.1.0",
      chainId: oceanConfig.chainId,
      nftAddress: nftAddress,
      metadata: {
        created: new Date().toISOString().replace(/\.[0-9]{3}/, '') + "Z",
        updated: new Date().toISOString().replace(/\.[0-9]{3}/, '') + "Z",
        type: "dataset",
        name: "VoidFiller Audit Data",
        description: "EU AI Act 2026 Audit Data - VoidFiller",
        author: "VoidFiller Agent",
        license: "MIT"
      },
      services: [
        {
          id: crypto.createHash('sha256').update("access"+datatokenAddress).digest('hex'),
          type: "access",
          files: encryptedFiles,
          datatokenAddress: datatokenAddress,
          serviceEndpoint: oceanConfig.providerUri,
          timeout: 0
        }
      ]
  };

  console.log("Validating DDO Services...");
  if (!ddo.services[0].id || !ddo.services[0].datatokenAddress) {
      throw new Error("Validation Failed: DDO services missing id or datatokenAddress.");
  }

  console.log("Encrypting DDO...");
  const encryptedDDO = await ProviderInstance.encrypt(ddo, oceanConfig.chainId, oceanConfig.providerUri, wallet);
  
  if(!encryptedDDO || !encryptedDDO.startsWith('0x')){
      throw new Error("Provider encryption failed or did not return 0x string.");
  }
  console.log("Encryption success!");
  
  const ddoString = JSON.stringify(ddo);
  const ddoHash = "0x" + crypto.createHash('sha256').update(ddoString).digest('hex');

  console.log("Sending setMetadata...");
  const nft = new Nft(wallet, oceanConfig.network, oceanConfig);
  const nftContract = nft.getContract(nftAddress);
  
  const fallbackGasLimit = process.env.GAS_LIMIT !== undefined && process.env.GAS_LIMIT !== '' && !isNaN(Number(process.env.GAS_LIMIT)) ? process.env.GAS_LIMIT : '3000000';
  const fallbackMaxFee = process.env.MAX_FEE !== undefined && process.env.MAX_FEE !== '' && !isNaN(Number(process.env.MAX_FEE)) ? process.env.MAX_FEE : '200000000000'; // 200 Gwei
  const fallbackPrioFee = process.env.PRIO_FEE !== undefined && process.env.PRIO_FEE !== '' && !isNaN(Number(process.env.PRIO_FEE)) ? process.env.PRIO_FEE : '60000000000';  // 60 Gwei

  const txOverrides = {
      gasLimit: ethers.BigNumber.from(fallbackGasLimit).toString(),
      maxFeePerGas: ethers.BigNumber.from(fallbackMaxFee).toString(),
      maxPriorityFeePerGas: ethers.BigNumber.from(fallbackPrioFee).toString()
  };

  const metaTxResponse = await nftContract.setMetaData(
      0, // state: active
      oceanConfig.providerUri,
      '0x0000000000000000000000000000000000000000',
      '0x02', // flags: encrypted
      encryptedDDO, // data bytes
      ddoHash, // metadata hash
      [], // empty proofs
      txOverrides
  );

  console.log("Tx Sent! Hash:", metaTxResponse.hash || metaTxResponse.transactionHash);
  let finalMetaTxHash = metaTxResponse.hash || metaTxResponse.transactionHash;

  console.log("Waiting for network confirmation...");
  const metaReceipt = await provider.waitForTransaction(finalMetaTxHash);

  if (metaReceipt.status === 0) {
      throw new Error("Transaction Reverted: " + finalMetaTxHash);
  }

  console.log(`\nMarketURL: https://market.oceanprotocol.com/asset/${didop}`);
}
main().catch(e => { console.error(e); process.exit(1); });
