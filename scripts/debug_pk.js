const { PublicKey } = require('@solana/web3.js');

try {
    const mintStr = '2qEHjDLDLbuBgRYvsnhKdD2g5MNcPTpyTAAAGdfpump';
    console.log(`String: "${mintStr}" Length: ${mintStr.length}`);

    const pk = new PublicKey(mintStr);
    console.log('✅ PublicKey verification passed:', pk.toBase58());

    const pumpProgram = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
    console.log('✅ Program ID verification passed:', pumpProgram.toBase58());

} catch (e) {
    console.error('❌ Failed:', e.message);
    console.error(e.stack);
}
