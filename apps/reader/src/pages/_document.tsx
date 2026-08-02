import { Html, Head, Main, NextScript } from 'next/document'

export default function Document() {
  return (
    // https://github.com/vercel/next.js/issues/10285
    // Next injects `<style data-next-hide-fouc="true">body{display:none}</style>`,
    // so we should set background on `html`
    <Html className="bg-default">
      <Head>
        <GoogleTagManager />
        <link rel="icon" href="/icons/192.png"></link>
        <PWA />
        <PreventFlash />
      </Head>
      <body>
        <GoogleTagManagerNoScript />
        <Main />
        <NextScript />
      </body>
    </Html>
  )
}

function PWA() {
  return (
    <>
      <link rel="manifest" href="/manifest.json" />
      <meta id="theme-color" name="theme-color" content={background.light} />
      <link rel="apple-touch-icon" href="/icons/192.png" />
    </>
  )
}

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID
const IS_EXTENSION_EXPORT = process.env.NEXT_PUBLIC_IS_EXPORT === 'true'

function GoogleTagManager() {
  // Published extensions must not load or execute third-party scripts.
  if (!GTM_ID || IS_EXTENSION_EXPORT) return null
  return (
    // eslint-disable-next-line @next/next/next-script-for-ga
    <script
      dangerouslySetInnerHTML={{
        __html: `
          (function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
          new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
          j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
          'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
          })(window,document,'script','dataLayer', '${GTM_ID}');
          `,
      }}
    />
  )
}

function GoogleTagManagerNoScript() {
  if (!GTM_ID) return null
  return (
    <noscript>
      <iframe
        src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
        height="0"
        width="0"
        style={{ display: 'none', visibility: 'hidden' }}
      ></iframe>
    </noscript>
  )
}

const background = {
  light: 'white',
  dark: '#24292e',
}

function PreventFlash() {
  return (
    <>
      <style>{`
        .bg-default, .hover\\:bg-default:hover {
          background: ${background.light};
        }
        .dark.bg-default, .dark .bg-default, .dark .hover\\:bg-default:hover {
          background: ${background.dark};
        }
      `}</style>
      <script src="/theme-init.js"></script>
    </>
  )
}
