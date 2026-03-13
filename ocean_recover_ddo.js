require('dotenv').config();
const { ethers } = require('ethers');
const { ProviderInstance, Nft, ConfigHelper } = require('@oceanprotocol/lib');
const crypto = require('crypto');

async function main() {
  const txHash = "0xa7d9d6c481d35a0aac4ffb431bd7219f57b7bd1a3b63dd98afe8fbb5ca514f12";
  const rpcUrl = process.env.RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const privateKey = process.env.OCEAN_PRIVATE_KEY;

  if (!privateKey) {
    throw new Error("OCEAN_PRIVATE_KEY is missing.");
  }

  // Polygon (137) を明示的に指定して接続エラーを回避
  const provider = new ethers.providers.JsonRpcProvider({
      url: rpcUrl,
      timeout: 30000
  }, 137); 

  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log("Fetching receipt for TX:", txHash);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Receipt not found.");

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

  if(!nftAddress || !datatokenAddress) throw new Error("NFT/Datatoken address not found.");
  console.log("Found NFT Address:", nftAddress);

  // 自前ノード (Ocean Node) のエンドポイント設定
  let oceanConfig = new ConfigHelper().getConfig(137) || {}; 
  oceanConfig.network = 'polygon';
  oceanConfig.chainId = 137;
  oceanConfig.providerUri = process.env.PROVIDER_URL || 'http://localhost:8000';
  oceanConfig.metadataCacheUri = process.env.AQUARIUS_URL || 'http://localhost:8000';

  console.log("Using Node Endpoint:", oceanConfig.providerUri);

  // DIDの生成
  const nftAddrLower = nftAddress.toLowerCase();
  const didHash = crypto.createHash('sha256').update(nftAddrLower + "137").digest('hex');
  const didop = "did:op:" + didHash;

  // ファイル情報の暗号化
  const fileObj = [{ type: "url", url: "https://example.com/hosted/voidfiller_v1.jsonl", method: "GET" }];
  console.log("Encrypting files via local node...");
  const encryptedFiles = await ProviderInstance.encrypt(fileObj, oceanConfig.chainId, oceanConfig.providerUri, wallet);

  // DDO構造の構築
  const now = new Date().toISOString().split('.')[0] + "Z";
  const ddo = {
      "@context": ["https://w3id.org/did/v1"],
      id: didop,
      version: "4.1.0",
      chainId: 137,
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

  console.log("Encrypting DDO...");
  const encryptedDDO = await ProviderInstance.encrypt(ddo, oceanConfig.chainId, oceanConfig.providerUri, wallet);
  
  const ddoString = JSON.stringify(ddo);
  const ddoHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(ddoString));

  console.log("Sending setMetadata...");
  const nft = new Nft(wallet, oceanConfig.network, oceanConfig);
  const nftContract = nft.getContract(nftAddress);
  
  const txOverrides = {
      gasLimit: "3000000",
      maxFeePerGas: "200000000000", 
      maxPriorityFeePerGas: "60000000000"
  };

  const metaTxResponse = await nftContract.setMetaData(
      0, 
      oceanConfig.providerUri,
      '0x0000000000000000000000000000000000000000',
      '0x02',
      encryptedDDO,
      ddoHash,
      [],
      txOverrides
  );

  console.log("Tx Sent! Hash:", metaTxResponse.hash);
  await provider.waitForTransaction(metaTxResponse.hash);

  console.log(`\nSUCCESS! MarketURL: https://market.oceanprotocol.com/asset/${didop}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
