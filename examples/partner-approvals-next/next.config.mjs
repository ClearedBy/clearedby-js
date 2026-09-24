/** @type {import('next').NextConfig} */
const nextConfig = {
  // Inside this monorepo the packages are consumed as TypeScript source.
  // (From npm they ship compiled; you can drop this line then.)
  transpilePackages: ['@clearedby/react', '@clearedby/sdk'],
}

export default nextConfig
