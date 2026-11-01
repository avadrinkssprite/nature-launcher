<p align="center">
  <img src="build/icon.png" width="128" alt="Nature Launcher icon: a pixel-art sunset over the sea">
</p>

<h1 align="center">Nature Launcher</h1>

<p align="center">A Minecraft launcher with instances, Modrinth built in, and a pixel-art ocean at dusk.</p>

<p align="center">
  <img src="docs/screenshot.png" alt="Nature Launcher home screen over the animated pixel-art ocean background">
</p>

## Features

- **Instances** for Vanilla, Fabric, Quilt, Forge and NeoForge, for every Mojang release (snapshots and old betas optional). Each instance has its own worlds, mods and settings.
- **Custom versions**: bring your own version `.json` (and `.jar`).
- **Manage content in the app**: mods, resource packs and shaders. Enable or disable, delete, add files or drag them in.
- **Modrinth built in**: search mods, resource packs and shaders filtered to the instance's version and loader, and install them with their required dependencies.
- **Modpacks**: import from Modrinth search or from a local `.mrpack` file.
- **Update all**: checks every mod, resource pack and shader against Modrinth, including files you added yourself.
- **Automatic Java**: downloads the right Java runtime for each Minecraft version (Java 8 for 1.8.9, 21 for 1.21, …).
- **Accounts**: Microsoft sign-in or an offline username.
- **Animated pixel-art background** drawn live on a canvas: clouds lit by the setting sun, moving waves, a lighthouse and gulls.

## Running it

Needs [Node.js](https://nodejs.org) 20 or newer.

```sh
npm install
npm start
```

## Building an exe

```sh
npm run dist
```

This creates `dist/win-unpacked/Nature Launcher.exe`. Keep the exe inside that folder, since it needs the files next to it.

## Where data lives

Everything (instances, game files, Java runtimes, settings) is stored in `%APPDATA%\nature-launcher`. Each instance is a folder under `instances/` with its own `mods`, `resourcepacks`, `shaderpacks` and `saves`.

## Project layout

| File | What it does |
| --- | --- |
| `main.js` | Electron main process: instances, Modrinth, modpacks, accounts |
| `mc.js` | Minecraft core: version resolving, libraries, assets, Java, loader installs, launching |
| `preload.js` | Bridge between the UI and the main process |
| `src/` | UI (`index.html`, `style.css`, `app.js`) and the background (`bg.js`) |
