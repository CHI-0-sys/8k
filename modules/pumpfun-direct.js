// modules/pumpfun-direct.js
// Direct pump.fun bonding curve trading – no Jupiter needed for curve phase

const {
    PublicKey,
    Transaction,
    ComputeBudgetProgram,
    SystemProgram
} = require('@solana/web3.js');

const {
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddressSync,
    createAssociatedTokenAccountInstruction
} = require('@solana/spl-token');

// Constants (verified December 2025)
const PUMP_FUN_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const GLOBAL = new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
const FEE_RECIPIENT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV2fskvCwf8gCDbZ');
const EVENT_AUTHORITY = new PublicKey('Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

const BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 237, 178, 9, 198, 242, 6]);

class PumpFunDirect {
    constructor(connection, logger) {
        this.connection = connection;
        this.logger = logger;
    }

    getBondingCurvePDA(mint) {
        const [pda] = PublicKey.findProgramAddressSync(
            [Buffer.from('bonding-curve'), mint.toBuffer()],
            PUMP_FUN_PROGRAM
        );
        return pda;
    }

    async ensureTokenAccount(mint, walletPubkey) {
        const ata = getAssociatedTokenAddressSync(mint, walletPubkey);
        const info = await this.connection.getAccountInfo(ata);
        if (info) return { exists: true, address: ata, instruction: null };

        const ix = createAssociatedTokenAccountInstruction(walletPubkey, ata, walletPubkey, mint);
        return { exists: false, address: ata, instruction: ix };
    }

    calculateMinOut(expected, slippageBps) {
        return Math.floor(expected * (1 - slippageBps / 10000));
    }

    async buildBuyInstruction({ mint, walletPubkey, amountLamports, minTokensOutLamports }) {
        const bondingCurve = this.getBondingCurvePDA(mint);
        const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
        const userTokenATA = getAssociatedTokenAddressSync(mint, walletPubkey);

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenATA, isSigner: false, isWritable: true },
            { pubkey: walletPubkey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];

        const data = Buffer.alloc(16);
        data.writeBigUInt64LE(BigInt(amountLamports), 0);
        data.writeBigUInt64LE(BigInt(minTokensOutLamports), 8);

        const ixData = Buffer.concat([BUY_DISCRIMINATOR, data]);

        return new TransactionInstruction({ keys, programId: PUMP_FUN_PROGRAM, data: ixData });
    }

    async buildSellInstruction({ mint, walletPubkey, tokenAmount, minSOLOutLamports }) {
        const bondingCurve = this.getBondingCurvePDA(mint);
        const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
        const userTokenATA = getAssociatedTokenAddressSync(mint, walletPubkey);

        const keys = [
            { pubkey: GLOBAL, isSigner: false, isWritable: false },
            { pubkey: FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: userTokenATA, isSigner: false, isWritable: true },
            { pubkey: walletPubkey, isSigner: true, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
            { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_FUN_PROGRAM, isSigner: false, isWritable: false },
        ];

        const data = Buffer.alloc(16);
        data.writeBigUInt64LE(BigInt(tokenAmount), 0);
        data.writeBigUInt64LE(BigInt(minSOLOutLamports), 8);

        const ixData = Buffer.concat([SELL_DISCRIMINATOR, data]);

        return new TransactionInstruction({ keys, programId: PUMP_FUN_PROGRAM, data: ixData });
    }

    async executeBuy({ wallet, mint, amountSOL, slippageBps = 1500, priorityFeeLamports = 100000 }) {
        try {
            const mintPubkey = new PublicKey(mint);
            const amountLamports = Math.floor(amountSOL * 1e9);
            const minTokensOut = 0; // You can improve estimation here

            const tokenAccount = await this.ensureTokenAccount(mintPubkey, wallet.publicKey);

            const tx = new Transaction();

            if (priorityFeeLamports > 0) {
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: Math.ceil(priorityFeeLamports / 1000)
                }));
            }

            if (tokenAccount.instruction) tx.add(tokenAccount.instruction);

            const buyIx = await this.buildBuyInstruction({
                mint: mintPubkey,
                walletPubkey: wallet.publicKey,
                amountLamports,
                minTokensOutLamports: minTokensOut
            });
            tx.add(buyIx);

            const { blockhash } = await this.connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = wallet.publicKey;
            tx.sign(wallet);

            const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                maxRetries: 3
            });

            await this.connection.confirmTransaction(sig, 'confirmed');

            return { success: true, signature: sig };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async executeSell({ wallet, mint, tokenAmount, slippageBps = 1500, priorityFeeLamports = 100000 }) {
        try {
            const mintPubkey = new PublicKey(mint);
            const minSOLOut = 0;

            const tx = new Transaction();

            if (priorityFeeLamports > 0) {
                tx.add(ComputeBudgetProgram.setComputeUnitPrice({
                    microLamports: Math.ceil(priorityFeeLamports / 1000)
                }));
            }

            const sellIx = await this.buildSellInstruction({
                mint: mintPubkey,
                walletPubkey: wallet.publicKey,
                tokenAmount,
                minSOLOutLamports: minSOLOut
            });
            tx.add(sellIx);

            const { blockhash } = await this.connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.feePayer = wallet.publicKey;
            tx.sign(wallet);

            const sig = await this.connection.sendRawTransaction(tx.serialize(), {
                skipPreflight: false,
                maxRetries: 3
            });

            await this.connection.confirmTransaction(sig, 'confirmed');

            return { success: true, signature: sig };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

module.exports = PumpFunDirect;