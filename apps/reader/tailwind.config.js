/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/**/*.{tsx,ts}', './node_modules/@literal-ui/core/**/*.js'],
  theme: {
    extend: {
      colors: {
        primary: 'rgb(var(--md-sys-color-primary) / <alpha-value>)',
        'background-light':
          'rgb(var(--md-sys-color-background) / <alpha-value>)',
        'background-dark':
          'rgb(var(--md-sys-color-background) / <alpha-value>)',
        'text-light': 'rgb(var(--md-sys-color-on-background) / <alpha-value>)',
        'text-dark': 'rgb(var(--md-sys-color-on-background) / <alpha-value>)',
        'subtle-light':
          'rgb(var(--md-sys-color-on-surface-variant) / <alpha-value>)',
        'subtle-dark':
          'rgb(var(--md-sys-color-on-surface-variant) / <alpha-value>)',
        'surface-light': 'rgb(var(--md-sys-color-surface) / <alpha-value>)',
        'surface-dark': 'rgb(var(--md-sys-color-surface) / <alpha-value>)',
        'border-light':
          'rgb(var(--md-sys-color-outline-variant) / <alpha-value>)',
        'border-dark':
          'rgb(var(--md-sys-color-outline-variant) / <alpha-value>)',
      },
      fontFamily: {
        display: ['Inter', 'sans-serif'],
        body: ['Georgia', 'serif'],
      },
      borderRadius: {
        DEFAULT: '0.5rem',
        lg: '0.75rem',
        xl: '1rem',
        full: '9999px',
      },
    },
    container: {
      center: true,
      padding: '1rem',
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
    require('@flow/tailwind'),
    require('@tailwindcss/line-clamp'),
  ],
}
