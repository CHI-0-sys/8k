const { PublicKey } = require('@solana/web3.js');
const { Metaplex } = require('@metaplex-foundation/js');
const axios = require('axios');

class TokenFilter {
    constructor(connection, logger) {
        this.connection = connection;
        this.logger = logger;
        this.metaplex = Metaplex.make(connection);
    }

    async analyzeToken(signature) {
        try {
            // 1. Fetch Transaction to get Mint Address
            // This is the bottleneck, so we need a good RPC or robust retry
            const tx = await this.connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0,
                commitment: 'confirmed'
            });

            if (!tx || !tx.meta || tx.meta.err) return null;

            // Find the mint address (usually the 0th or 1st account depending on instruction, 
            // but for Pump.fun Create, it's often passed as a writable account)
            const postBalances = tx.meta.postTokenBalances || [];
            if (postBalances.length === 0) return null;

            const newMint = postBalances.find(b =>
                (b.uiTokenAmount.uiAmount > 900000000) &&
                b.mint !== 'So11111111111111111111111111111111111111112'
            );

            if (!newMint) return null;

            const mintAddress = newMint.mint;
            const blockTime = tx.blockTime;
            const now = Math.floor(Date.now() / 1000);

            const ageSeconds = now - blockTime;
            if (ageSeconds > 90) return null;

            const hasTwitter = await this.checkSocials(mintAddress);
            if (!hasTwitter) return null;

            // --- Advanced Security Checks (Added Request) ---

            // 1. Top 10 Holder Analysis
            const isDistributionSafe = await this.checkHolderDistribution(mintAddress);
            if (!isDistributionSafe) {
                this.logger.warn(`Token rejected by Holder Analysis: ${mintAddress}`);
                return null;
            }

            // 2. Pure RPC Authority Check (Replaces RugCheck API)
            const isAuthoritySafe = await this.checkTokenAuthorities(mintAddress);
            if (!isAuthoritySafe) {
                this.logger.warn(`Token rejected by Authority Check: ${mintAddress}`);
                return null;
            }

            // ------------------------------------------------

            return {
                mint: mintAddress,
                signature: signature,
                age: ageSeconds,
                hasTwitter: true,
                timestamp: Date.now()
            };

        } catch (error) {
            this.logger.error('Filter analysis failed', { signature, error: error.message });
            return null;
        }
    }

    async checkSocials(mintAddress) {
        try {
            const mint = new PublicKey(mintAddress);
            const metadataPda = this.metaplex.nfts().pdas().metadata({ mint });

            const info = await this.connection.getAccountInfo(metadataPda);
            if (!info) return false;

            // Decode metadata using Metaplex or custom parser
            // Fast/lazy way: convert buffer to string and look for "twitter.com" or "x.com" in the URI
            // But better: use the Metaplex SDK properly if initialized, or just the URI

            const metadata = await this.metaplex.nfts().findByMint({ mintAddress: mint });

            if (metadata && metadata.json) {
                const json = metadata.json;
                return (
                    (json.twitter && json.twitter.length > 0) ||
                    (json.extensions && json.extensions.twitter) ||
                    (json.description && (json.description.includes('twitter.com') || json.description.includes('x.com')))
                );
            }

            // Fallback: if json not loaded, try to fetch uri
            if (metadata && metadata.uri) {
                const response = await axios.get(metadata.uri, { timeout: 2000 });
                const json = response.data;
                return (
                    (json.twitter && json.twitter.length > 0) ||
                    (json.extensions && json.extensions.twitter) ||
                    (json.description && (json.description.includes('twitter.com') || json.description.includes('x.com')))
                );
            }

            return false;
        } catch (error) {
            // Metadata might not be set yet for brand new tokens
            return false;
        }
    }

    async checkTokenAuthorities(mint) {
        try {
            const mintPubkey = new PublicKey(mint);

            // Fetch parsed account info (the RPC does the layout decoding for us)
            const accountInfo = await this.connection.getParsedAccountInfo(mintPubkey);

            if (!accountInfo || !accountInfo.value || !accountInfo.value.data || !accountInfo.value.data.parsed) {
                this.logger.warn(`Could not fetch mint info for ${mint}`);
                // If we can't find the mint account, it's unsafe or RPC error. Default to safe/reject?
                // Rejecting is safer.
                return false;
            }

            const info = accountInfo.value.data.parsed.info;

            // 1. Freeze Authority Check (Critical)
            // It MUST be null. If someone can freeze the token, it's a honeypot.
            if (info.freezeAuthority !== null) {
                this.logger.warn(`Risk Reject ${mint}: Freeze Authority Enabled (${info.freezeAuthority})`);
                return false;
            }

            // 2. Mint Authority Check (Nuanced)
            // On Pump.fun, the Mint Authority IS the Bonding Curve.
            // If it's a random wallet, that's a risk (dev can print infinite tokens).
            // If it's null (renounced), that's safe.
            // If it's the Curve, that's safe (for now).

            if (info.mintAuthority !== null) {
                const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
                const [bondingCurve] = PublicKey.findProgramAddressSync(
                    [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
                    PUMP_PROGRAM
                );

                if (info.mintAuthority !== bondingCurve.toBase58()) {
                    this.logger.warn(`Risk Reject ${mint}: Mint Authority is not Curve/Renounced (` + info.mintAuthority + `)`);
                    return false;
                }
            }

            return true;

        } catch (error) {
            this.logger.error(`Authority check failed for ${mint}`, { error: error.message });
            return false;
        }
    }

    async checkHolderDistribution(mint) {
        try {
            const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
            // Derive Bonding Curve PDA to exclude it
            const [bondingCurve] = PublicKey.findProgramAddressSync(
                [Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()],
                PUMP_PROGRAM
            );
            const bondingCurveAddr = bondingCurve.toBase58();

            // Fetch Top 20 accounts (to ensure we have enough after filtering curve)
            const accounts = await this.connection.getTokenLargestAccounts(new PublicKey(mint));

            if (!accounts || !accounts.value) return false;

            let top10Supply = 0;
            let supply = 1_000_000_000 * 1e6; // Pump.fun is 1B supply with 6 decimals usually
            // Better: fetch mint info for exact supply, but 1B is standard for Pump

            // Filter and Sum
            const holders = accounts.value.filter(acc => acc.address !== bondingCurveAddr);

            // Sum Top 10 real holders
            const top10 = holders.slice(0, 10);
            const top10Total = top10.reduce((sum, acc) => sum + (acc.uiAmount || 0), 0);

            // 1B supply. If Top 10 hold > 300M (30%), Reject.
            const concentration = (top10Total / 1_000_000_000) * 100;

            if (concentration > 30) {
                this.logger.warn(`Holder check failed for ${mint}: Top 10 hold ${concentration.toFixed(1)}% (Limit 30%)`);
                return false;
            }

            return true;

        } catch (error) {
            this.logger.error(`Holder check failed for ${mint}`, { error: error.message });
            return false;
        }
    }
}

module.exports = TokenFilter;
