> **Поддержать автора:** [DonationAlerts](https://www.donationalerts.com/r/link_it)

<p align="center">
  <img src="media/icon.png" alt="Cursor Skills Hub" width="128">
</p>

# Cursor Skills Hub

Расширение только для Cursor. Установите навыки и плагины один раз, храните один и тот же набор на всех компьютерах через приватный репозиторий GitHub и обновляйте его из редактора.

[English](README.md)

Подключение маркетплейса только индексирует каталог. Компонент ставится, когда его выбираете вы или агент.

## Установка

Только Cursor. Каждая команда скачивает текущий пакет и сразу ставит его.

macOS и Linux:

```bash
curl -fsSL -o /tmp/cursor-skills-hub.vsix https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix && cursor --install-extension /tmp/cursor-skills-hub.vsix
```

```bash
wget -qO /tmp/cursor-skills-hub.vsix https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix && cursor --install-extension /tmp/cursor-skills-hub.vsix
```

Windows, PowerShell:

```powershell
curl.exe -fsSL -o "$env:TEMP\cursor-skills-hub.vsix" https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix; if ($?) { cursor --install-extension "$env:TEMP\cursor-skills-hub.vsix" }
```

Windows, командная строка:

```bat
curl -fsSL -o "%TEMP%\cursor-skills-hub.vsix" https://github.com/Devisione/cursor-skills-hub/releases/latest/download/cursor-skills-hub.vsix && cursor --install-extension "%TEMP%\cursor-skills-hub.vsix"
```

Другие версии лежат на странице [релизов](https://github.com/Devisione/cursor-skills-hub/releases). Перезагрузите окно, когда Cursor попросит. После этого Skills Hub появляется на боковой панели.

## Куда ставятся компоненты

Расширение не меняет файлы Cursor. Оно пишет в каталоги, которые Cursor уже сканирует:

- навыки пользователя: `~/.cursor/skills` или `~/.agents/skills`
- навыки проекта: `.cursor/skills` или `.agents/skills`
- плагины пользователя: `~/.cursor/plugins/local`
- плагины проекта: `.cursor/plugins`

Встроенные навыки и навыки, которые пришли вместе с плагином, остаются на месте.

## Синхронизация

Приватный репозиторий GitHub хранит список маркетплейсов, установленных компонентов, настройки и точные версии. Сами каталоги на GitHub не копируются: каждый компьютер индексирует их заново.

Токен GitHub хранится в Secret Storage. В конфигурационный репозиторий и в лог Skills Hub он не записывается. Адрес репозитория с логином или паролем отклоняется.

Скрипты внутри навыка при установке не запускаются. Симлинки и пути вне каталога компонента не копируются.

## Разработка

```bash
npm install
npm test
```

`npm test` компилирует TypeScript и запускает `node --test`. Конфигурация запуска **Run Skills Hub** нужна только для разработки.

## Лицензия

[MIT](LICENSE)
