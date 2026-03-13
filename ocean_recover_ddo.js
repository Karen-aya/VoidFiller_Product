require('dotenv').config();
const { ethers } = require('ethers');
const { ProviderInstance, Nft, ConfigHelper } = require('@oceanprotocol/lib');
const crypto = require('crypto');

async function main() {
  // 対象のアセットが作成されたトランザクションハッシュ
  const txHash = "0xa7d9d6c481d35a0aac4ffb431bd7219f57b7bd1a3b63dd98afe8fbb5ca514f12";
  const rpcUrl = process.env.RPC_URL || 'https://polygon-rpc.com';
  const privateKey = process.env.OCEAN_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("OCEAN_PRIVATE_KEY is not defined in environment variables.");
  }

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

  // Config context: 2026年仕様
  let oceanConfig = new ConfigHelper().getConfig(137) || {}; 
  oceanConfig.network = 'polygon';
  oceanConfig.chainId = 137;

  // 【最重要】消滅した v4.aquarius... ではなく、Actionsで立ち上げた自前ノードを参照
  oceanConfig.providerUri = process.env.PROVIDER_URL || 'http://localhost:8000';
  oceanConfig.metadataCacheUri = process.env.AQUARIUS_URL || 'http://localhost:8000';

  console.log("Using Node Endpoint:", oceanConfig.providerUri);

  // --- DIDの生成 (公式仕様準拠) ---
  const nftAddrLower = nftAddress.toLowerCase();
  const chainIdStr = oceanConfig.chainId.toString();
  const didHash = crypto.createHash('sha256').update(nftAddrLower + chainIdStr).digest('hex');
  const didop = "did:op:" + didHash;
  console.log("Calculated DID:", didop);

  // ファイル情報の暗号化
  const fileObj = [
    {
      type: "url",
      url: "https://example.com/hosted/voidfiller_v1.jsonl",
      method: "GET"
    }
  ];
  
  console.log("Encrypting files via local node...");
  const encryptedFiles = await ProviderInstance.encrypt(fileObj, oceanConfig.chainId, oceanConfig.providerUri, wallet);

  // DDO構造の構築 (2026年 Aquarius/Node バリデーション準拠)
  const now = new Date().toISOString().split('.')[0] + "Z";
  const ddo = {
      "@context": ["https://w3id.org/did/v1"],
      id: didop,
      version: "4.1.0",
      chainId: oceanConfig.chainId,
      nftAddress: nftAddress,
      metadata: {
        created: now,
        updated: now,
        type: "dataset",
        name: "VoidFiller Audit Data",
        description: "EU AI Act 2026 Audit Data - VoidFiller",
        author: "VoidFiller Agent",
        license: "MIT"
      },
      services: [
        {
          id: "0",
          type: "access",
          files: encryptedFiles,
          datatokenAddress: datatokenAddress,
          serviceEndpoint: oceanConfig.providerUri,
          timeout: 0
        }
      ]
  };

  console.log("Encrypting DDO via local node...");
  const encryptedDDO = await ProviderInstance.encrypt(ddo, oceanConfig.chainId, oceanConfig.providerUri, wallet);
  
  if(!encryptedDDO || !encryptedDDO.startsWith('0x')){
      throw new Error("Provider encryption failed or did not return 0x string.");
  }

  // 正規化されたJSONのKeccak256ハッシュを計算
  const ddoString = JSON.stringify(ddo);
  const ddoHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(ddoString));

  console.log("Sending setMetadata to Polygon...");
  const nft = new Nft(wallet, oceanConfig.network, oceanConfig);
  const nftContract = nft.getContract(nftAddress);
  
  const fallbackGasLimit = process.env.GAS_LIMIT || '3000000';
  const fallbackMaxFee = process.env.MAX_FEE || '200000000000'; 
  const fallbackPrioFee = process.env.PRIO_FEE || '60000000000'; 

  const txOverrides = {
      gasLimit: ethers.BigNumber.from(fallbackGasLimit).toString(),
      maxFeePerGas: ethers.BigNumber.from(fallbackMaxFee).toString(),
      maxPriorityFeePerGas: ethers.BigNumber.from(fallbackPrioFee).toString()
  };

  const metaTxResponse = await nftContract.setMetaData(
      0, // state: active
      oceanConfig.providerUri,
      '0x0000000000000000000000000000000000000000',
      '0x02', // flags: encrypted (暗号化済みフラグ)
      encryptedDDO,
      ddoHash,
      [],
      txOverrides
  );

  console.log("Tx Sent! Hash:", metaTxResponse.hash || metaTxResponse.transactionHash);
  const finalMetaTxHash = metaTxResponse.hash || metaTxResponse.transactionHash;

  console.log("Waiting for network confirmation...");
  const metaReceipt = await provider.waitForTransaction(finalMetaTxHash);

  if (metaReceipt.status === 0) {
      throw new Error("Transaction Reverted: " + finalMetaTxHash);
  }

  console.log("\n--- SUCCESS ---");
  console.log(`DID: ${didop}`);
  console.log(`MarketURL: https://market.oceanprotocol.com/asset/${didop}`);
}

main().catch(e => {
  console.error("Error occurred during DDO recovery:");
  console.error(e);
  process.exit(1);
});
