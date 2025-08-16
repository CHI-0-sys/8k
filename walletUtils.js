// walletUtils.js
const { Keypair } = require("@solana/web3.js");

function generateWallet() {
  const keypair = Keypair.generate();
  return {
    publicKey: keypair.publicKey.toBase58(),
    privateKey: Buffer.from(keypair.secretKey).toString("base64"),
  };
}

function loadKeypair(base64) {
  return Keypair.fromSecretKey(Uint8Array.from(Buffer.from(base64, "base64")));
}

module.exports = { generateWallet, loadKeypair };
