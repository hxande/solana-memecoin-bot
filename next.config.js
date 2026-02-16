/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['@solana/web3.js', '@solana/spl-token', 'bs58', 'telegraf', 'ws'],
};

module.exports = nextConfig;
