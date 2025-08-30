# Flow Reader Extension

This is a fork of the original [Flow](https://github.com/pacexy/flow) ePub reader, with a focus on improving and stabilizing the browser extension.

<p align="center"><img src="apps/website/public/screenshots/en-US.webp"/>
</p>

## Features

- Grid layout
- Search in book
- Image preview
- Custom typography
- Highlight and Annotation
- Theme
- Data export
- Cloud storage

## Setup and Development

Follow these steps to set up the development environment and build the extension from the source code.

### 1. Prerequisites

- [Node.js](https://nodejs.org) (v18 or higher)
- [pnpm](https://pnpm.io/installation)
- [Git](https://git-scm.com/downloads)

### 2. Clone the Repository

```bash
git clone https://github.com/Zolangui/Flow-Reader-Extension.git
cd Flow-Reader-Extension
```

### 3. Install Dependencies

```bash
pnpm i
```

### 4. Set Up Environment Variables

This project uses environment variables for configuration. Copy the example files and fill in the required values.

```bash
cp apps/reader/.env.local.example apps/reader/.env.local
# You may need to do this for other apps if you intend to use them.
```

### 5. Build the Extension

The extension needs to be built before it can be loaded into a browser.

-   **For Chrome:**
    ```bash
    pnpm build:ext:chrome
    ```
-   **For Firefox:**
    ```bash
    pnpm build:ext:firefox
    ```

The built extension files will be located in the `apps/extension/dist` directory.

### 6. Load the Extension in Your Browser

#### Chrome

1.  Open Google Chrome and navigate to `chrome://extensions`.
2.  Enable "Developer mode" using the toggle switch in the top-right corner.
3.  Click the "Load unpacked" button.
4.  In the file dialog, select the `apps/extension/dist` directory from this project.
5.  The "Flow" extension will now be installed.

#### Firefox

1.  Open Mozilla Firefox and navigate to `about:debugging`.
2.  Click on the "This Firefox" tab on the left.
3.  Click the "Load Temporary Add-on..." button.
4.  In the file dialog, navigate to the `apps/extension/dist` directory and select the `manifest.json` file.
5.  The "Flow" extension will now be temporarily installed.

### Packaging for Distribution

If you want to create a distributable zip file of the extension:

-   **For Chrome:**
    ```bash
    pnpm package:chrome
    ```
-   **For Firefox:**
    ```bash
    pnpm package:firefox
    ```

## Contributing

All contributions are welcome!

- [Submit bugs and feature requests](https://github.com/Zolangui/Flow-Reader-Extension/issues/new)
- [Submit pull requests](https://github.com/Zolangui/Flow-Reader-Extension/pulls)

## Credits

- [Epub.js](https://github.com/futurepress/epub.js/)
- [React](https://github.com/facebook/react)
- [Next.js](https://nextjs.org/)
- [TypeScript](https://www.typescriptlang.org)
- [Vercel](https://vercel.com)
- [Turborepo](https://turbo.build/repo)
