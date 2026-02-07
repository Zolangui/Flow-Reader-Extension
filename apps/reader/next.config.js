/* eslint-disable import/order */
const path = require('path')

const { withSentryConfig } = require('@sentry/nextjs')
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
})

const IS_EXPORT = process.env.NEXT_PUBLIC_IS_EXPORT === 'true'

const withPWA = require('next-pwa')({
  dest: 'public',
  disable: IS_EXPORT,
})
const withTM = require('next-transpile-modules')([
  '@flow/internal',
  '@flow/epubjs',
  '@material/material-color-utilities',
  'voy-search',
  '@wllama/wllama',
])

const IS_DEV = process.env.NODE_ENV === 'development'
const IS_DOCKER = process.env.DOCKER

/**
 * @type {import('@sentry/nextjs').SentryWebpackPluginOptions}
 **/
const sentryWebpackPluginOptions = {
  // Additional config options for the Sentry Webpack plugin. Keep in mind that
  // the following options are set automatically, and overriding them is not
  // recommended:
  //   release, url, org, project, authToken, configFile, stripPrefix,
  //   urlPrefix, include, ignore

  silent: true, // Suppresses all logs
  // For all available options, see:
  // https://github.com/getsentry/sentry-webpack-plugin#options.
}

/**
 * @type {import('next').NextConfig}
 **/
let config = {
  swcMinify: false, // Use Terser instead of SWC (Fixes Zod v4 mangling bug in Next.js 12)
  compress: process.env.FAST_BUILD !== 'true', // Disable gzip for fast builds
  productionBrowserSourceMaps: false, // Disable for faster builds
  typescript: {
    ignoreBuildErrors: process.env.FAST_BUILD === 'true', // Skip type-checking ONLY in fast build
  },
  eslint: {
    ignoreDuringBuilds: process.env.FAST_BUILD === 'true', // Skip linting ONLY in fast build
  },
  pageExtensions: ['ts', 'tsx'],
  webpack(config, { dev, isServer }) {
    if (process.env.FAST_BUILD === 'true') {
      config.optimization.minimize = false
    }

    // SOTA 2026: Use Esbuild for minification to fix Zod v4 mangling in Next.js 12
    if (!dev && !isServer) {
      const { EsbuildPlugin } = require('esbuild-loader')
      config.optimization.minimizer = [
        new EsbuildPlugin({
          target: 'esnext',
          keepNames: true, // Prevent Zod/Valtio property mangling
          css: true, // SOTA: Minify CSS with Esbuild
        }),
      ]
    }

    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
      layers: true,
    }

    return config
  },
  ...(IS_DOCKER && {
    output: 'standalone',
    experimental: {
      outputFileTracingRoot: path.join(__dirname, '../../'),
    },
  }),
}

if (!IS_EXPORT) {
  config.i18n = {
    locales: ['en-US', 'pt-BR', 'es-ES', 'fr-FR', 'de-DE', 'zh-CN', 'ja-JP'],
    defaultLocale: 'en-US',
  }
} else {
  config.images = {
    unoptimized: true,
  }
}

const base = withPWA(withTM(withBundleAnalyzer(config)))

const dev = base
const docker = base

// Only enable Sentry if not skipped
const shouldEnableSentry = !process.env.SKIP_SENTRY
const prod = shouldEnableSentry
  ? withSentryConfig(
    base,
    // Make sure adding Sentry options is the last code to run before exporting, to
    // ensure that your source maps include changes from all other Webpack plugins
    sentryWebpackPluginOptions,
  )
  : base

module.exports = IS_DEV ? dev : IS_DOCKER ? docker : prod
