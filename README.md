> **Support the author:** [DonationAlerts](https://www.donationalerts.com/r/link_it)

<p align="center">
  <img src="media/icon.png" alt="Cursor Skills Hub" width="128">
</p>

# Cursor Skills Hub

Cursor extension. Install Agent Skills and Plugins once, keep the same set on every device through a private GitHub repository, and update them from the editor.

[Русский](README.ru.md)

Connecting a marketplace only indexes the catalog. A component is installed when you or the agent choose it.

## Install

Cursor only. Each command downloads the current package and installs it.

macOS and Linux:

```bash
curl -fsSL -o /tmp/cursor-skills-hub.vsix https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix && cursor --install-extension /tmp/cursor-skills-hub.vsix
```

```bash
wget -qO /tmp/cursor-skills-hub.vsix https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix && cursor --install-extension /tmp/cursor-skills-hub.vsix
```

Windows PowerShell:

```powershell
curl.exe -fsSL -o "$env:TEMP\cursor-skills-hub.vsix" https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix; if ($?) { cursor --install-extension "$env:TEMP\cursor-skills-hub.vsix" }
```

Windows Command Prompt:

```bat
curl -fsSL -o "%TEMP%\cursor-skills-hub.vsix" https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix && cursor --install-extension "%TEMP%\cursor-skills-hub.vsix"
```

Other versions are on [Releases](https://github.com/Devisione/cursor-skills-hub/releases). Reload the window when Cursor asks. Skills Hub then appears on the side bar.

## Where components go

The extension does not change Cursor's application files. It writes into directories Cursor already scans:

- user skills: `~/.cursor/skills` or `~/.agents/skills`
- project skills: `.cursor/skills` or `.agents/skills`
- user plugins: `~/.cursor/plugins/local`
- project plugins: `.cursor/plugins`

Built-in skills and skills that belong to a plugin are left in place.

## Sync

A private GitHub repository stores the marketplace list, installed components, settings, and exact versions. The catalogs themselves stay on each device and are indexed again there.

The GitHub token stays in Secret Storage. It is not written to the configuration repository or to the Skills Hub log. A repository URL that contains a login or password is rejected.

Scripts inside a skill are not executed during install. Symlinks and paths outside the component directory are not copied.

## Development

```bash
npm install
npm test
```

`npm test` compiles TypeScript and runs `node --test`. The **Run Skills Hub** launch configuration is for development.

## License

[MIT](LICENSE)
