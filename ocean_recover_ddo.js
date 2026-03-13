require('dotenv').config();
const { ethers } = require('ethers');
const { Nft } = require('@oceanprotocol/lib');

async function main() {
  const txHash = "0xa7d9d6c481d35a0aac4ffb431bd7219f57b7bd1a3b63dd98afe8fbb5ca514f12";
  const rpcUrl = process.env.RPC_URL || 'https://polygon-bor-rpc.publicnode.com';
  const privateKey = process.env.OCEAN_PRIVATE_KEY;

  if (!privateKey) throw new Error("Private Key is missing.");

  // ethers v6 の最新の書き方
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  
  console.log("Fetching transaction receipt...");
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Receipt not found.");

  // NFTとDatatokenのアドレスを抽出
  let nftAddress, datatokenAddress;
  const nftCreatedTopic = ethers.id("NFTCreated(address,address,uint256,address,address,string,string,address,uint256,address)");
  const tokenCreatedTopic = ethers.id("TokenCreated(address,address,uint256,uint256,address,address,address,address,uint256)");

  for (const log of receipt.logs) {
    if (log.topics[0] === nftCreatedTopic) nftAddress = ethers.getAddress("0x" + log.data.substring(26, 66));
    if (log.topics[0] === tokenCreatedTopic) datatokenAddress = ethers.getAddress("0x" + log.topics[1].substring(26, 66));
  }

  if(!nftAddress || !datatokenAddress) {
      throw new Error("Could not find NFT or Datatoken address in the transaction logs.");
  }

  console.log(`Target NFT: ${nftAddress}`);
  console.log(`Target Datatoken: ${datatokenAddress}`);

  const providerUri = 'https://v4.provider.polygon.oceanprotocol.com';
  const chainId = 137;
  
  // DIDの生成
  const did = "did:op:" + ethers.keccak256(ethers.solidityPacked(["address", "uint256"], [nftAddress, chainId])).substring(2);

  // 1. ファイル情報の暗号化 (最新の標準fetchを使用)
  console.log("Encrypting files with Ocean Provider...");
  const fileObj = {
    datatokenAddress,
    nftAddress,
    files: [{ type: "url", url: "https://example.com/hosted/voidfiller_v1.jsonl", method: "GET" }]
  };

  const encFilesResponse = await fetch(`${providerUri}/api/v1/services/encrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fileObj)
  });
  const encryptedFiles = await encFilesResponse.text();

  // 2. DDO (メタデータ) の作成
  const ddo = {
    "@context": ["https://w3id.org/did/v1"],
    id: did,
    version: "4.5.0",
    chainId,
    nftAddress,
    metadata: {
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      type: "dataset",
      name: "VoidFiller Audit Data (v6)",
      description: "EU AI Act 2026 Audit Data - VoidFiller",
      author: "VoidFiller Agent",
      license: "MIT"
    },
    services: [{
      id: ethers.id("access" + datatokenAddress).substring(2),
      type: "access",
      files: encryptedFiles,
      datatokenAddress,
      serviceEndpoint: providerUri,
      timeout: 0
    }]
  };

  // 3. DDO自体の暗号化
  console.log("Encrypting DDO...");
  const encDdoResponse = await fetch(`${providerUri}/api/v1/services/encrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ddo)
  });
  const encryptedDdo = await encDdoResponse.text();
  const ddoHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(ddo)));

  // 4. オンチェーンへの書き込み
  console.log("Sending setMetadata to Polygon...");
  const nft = new Nft(wallet);
  
  const tx = await nft.setMetadata(
    nftAddress,
    0,
    providerUri,
    wallet.address,
    "0x02", // encrypted flag
    ethers.toUtf8Bytes(encryptedDdo),
    ddoHash,
    []
  );

  console.log("Tx Sent! Hash:", tx.hash);
  await tx.wait();
  console.log(`\n🎉 Success! Market URL: https://market.oceanprotocol.com/asset/${did}`);
}

main().catch(error => {
  console.error("Fatal Error:", error);
  process.exit(1);
});
