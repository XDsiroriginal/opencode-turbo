# opencode-turbo

Плагин для [OpenCode](https://opencode.ai), который экономит контекст и ускоряет любые сессии — независимо от модели и провайдера.

Плагин не привязан к `big-pickle`: он работает с любой моделью (OpenCode Zen, Ollama, LM Studio, OpenAI-совместимые API и т.д.).

## Что делает

- Сжимает большие выводы инструментов (`bash`, `read`, `grep`, `webfetch` и др.) перед отправкой в модель.
- Сохраняет полный вывод на диск, в модель отправляет только голову/хвост и важные строки (ошибки, исключения, `exit code` и т.п.).
- Сжимает старую историю диалога, сохраняя последние ходы без изменений.
- Пишет локальные метрики экономии в `~/.config/opencode/turbo-metrics.jsonl`.
- Опционально подменяет `small_model` для локальных провайдеров; для любого провайдера это можно включить явно через переменную окружения.

По умолчанию ничего не отправляет по сети и не содержит телеметрии.

## Установка

### 1. Глобально (для всех проектов)

Скопируйте `index.ts` в глобальную папку плагинов OpenCode:

**Windows (PowerShell):**

```powershell
$dir = Join-Path $HOME ".config\opencode\plugins"
New-Item -ItemType Directory -Force $dir | Out-Null
Invoke-WebRequest "https://raw.githubusercontent.com/XDsiroriginal/opencode-turbo/main/index.ts" -OutFile (Join-Path $dir "turbo.ts")
```

**Linux / macOS:**

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://raw.githubusercontent.com/XDsiroriginal/opencode-turbo/main/index.ts -o ~/.config/opencode/plugins/turbo.ts
```

Перезапустите OpenCode. Плагины из `~/.config/opencode/plugins/` загружаются автоматически.

### 2. Только для проекта

Положите файл в `.opencode/plugins/turbo.ts` в корне проекта:

```bash
mkdir -p .opencode/plugins
curl -fsSL https://raw.githubusercontent.com/XDsiroriginal/opencode-turbo/main/index.ts -o .opencode/plugins/turbo.ts
```

### 3. Через npm (после публикации пакета)

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-turbo"]
}
```

OpenCode сам установит npm-плагин через Bun при старте.

### 4. Из локального клона

```bash
git clone https://github.com/XDsiroriginal/opencode-turbo.git
cp opencode-turbo/index.ts ~/.config/opencode/plugins/turbo.ts
```

## Настройка

Все настройки необязательны. Значения по умолчанию подходят для большинства случаев.

| Переменная | По умолчанию | Описание |
|---|---|---|
| `OPENCODE_TURBO` | `true` | Включить/выключить плагин (`0`, `false`, `no`, `off` — выключить). |
| `OPENCODE_TURBO_METRICS` | `true` | Писать локальные метрики. |
| `OPENCODE_TURBO_SMALL_MODEL` | `ollama/qwen2.5:7b` для локальных моделей | Явно задать small model, например `opencode/big-pickle` или `ollama/qwen2.5:7b`. Пустое значение отключает подмену. |
| `OPENCODE_TURBO_PROTECT_TOOLS` | `skill,task` | Инструменты, чей вывод не сжимать (через запятую). |
| `OPENCODE_TURBO_KEEP_TURNS` | `2` | Сколько последних ходов не сжимать. |
| `OPENCODE_TURBO_HISTORY_THRESHOLD` | `3000` | Порог в байтах для сжатия старой истории. |

Пример для Windows (текущая сессия PowerShell):

```powershell
$env:OPENCODE_TURBO_SMALL_MODEL = "ollama/qwen2.5:7b"
opencode
```

Пример для Linux/macOS:

```bash
export OPENCODE_TURBO_SMALL_MODEL="ollama/qwen2.5:7b"
opencode
```

## Проверка работы

1. Запустите любую сессию:

```bash
opencode run "Reply with exactly: PONG" -m opencode/big-pickle --auto
```

2. Проверьте метрики:

```powershell
Get-Content "$HOME\.config\opencode\turbo-metrics.jsonl" -Tail 5
```

```bash
tail -n 5 ~/.config/opencode/turbo-metrics.jsonl
```

Ищите записи `"type":"fresh"` — это факты сжатия вывода инструментов, и `"type":"turn"` — статистика по ходам.

3. Проверьте, что полные выводы сохраняются локально:

```text
~/.local/share/opencode/tool-output/
```

## Безопасность

- Плагин не делает сетевых запросов и не отправляет данные наружу.
- Полные выводы инструментов остаются на вашем диске в `tool-output/`.
- Метрики пишутся только локально в `turbo-metrics.jsonl`.
- В репозитории нет ключей, токенов, паролей, баз данных и логов.
- Плагин не читает `.env`, `auth.json` и другие секреты специально; он работает только с выводом инструментов и историей сообщений OpenCode.
- Файлы, на которые ссылается строка `Full output saved to: ...`, читаются только из каталога `tool-output` (защита от path traversal).

Если нашли проблему безопасности — создайте issue без публикации чувствительных данных.

## Совместимость

- OpenCode `>= 1.18`.
- TypeScript-плагин, дополнительных runtime-зависимостей нет.
- Работает на Windows, Linux и macOS.

## Лицензия

MIT. См. [LICENSE](LICENSE).
