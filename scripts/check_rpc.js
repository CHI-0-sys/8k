require('dotenv').config();

const rpcUrl = process.env.PRIMARY_RPC_URL || '';

console.log('--- RPC CONFIGURATION CHECK ---');
console.log(`Length: ${rpcUrl.length} characters`);

if (rpcUrl.length === 0) {
    console.error('❌ ERROR: PRIMARY_RPC_URL is empty!');
} else {
    console.log(`Start:  ${rpcUrl.substring(0, 15)}...`);
    console.log(`End:    ...${rpcUrl.substring(rpcUrl.length - 15)}`);

    if (rpcUrl.includes('wider-sleek-market.solana-mainne') && !rpcUrl.includes('.pro')) {
        console.error('❌ DETECTED TRUNCATED URL (QuickNode)');
        console.error('It looks like you are missing the end of the URL (.pro/...)');
    } else if (!rpcUrl.startsWith('https://')) {
        console.error('❌ ERROR: URL must start with https://');
    } else {
        console.log('✅ URL format looks plausible (Length > 20, starts with https)');
    }
}
console.log('-------------------------------');
