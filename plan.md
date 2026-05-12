# Plan: ralpix — Autonomous Plan Execution Extension for pi

## Overview

ralpix — это extension для pi, который читает markdown-планы в формате ralpix и автономно выполняет задачи. Каждая задача запускается в **новой сессии** pi, чтобы сохранить качество контекстного окна модели. После выполнения всех задач запускается multi-phase review pipeline (опционально с другими моделями/провайдерами). Прогресс пишется в `.ralpix/progress/`.

**Что есть:**
- Автономное выполнение задач (hands-off)
- Изолированные сессии для каждого шага
- Настраиваемые модели/провайдеры на уровне шага и фазы
- Промпты в отдельных `.md` файлах (шаблоны с переменными)
- Auto-commit в текущую ветку после каждого шага
- Review pipeline внутри pi (first pass: 5 агентов, second pass: 2 агента)
- Progress log в `.ralpix/progress/<plan-name>.txt`

**Чего нет в MVP:**
- Веб-дашборд
- Уведомления (Telegram, Slack, etc.)
- Git worktree isolation
- External review tools (codex)
- Validation commands

## Context

- **Платформа:** pi coding agent (TypeScript extensions, SDK)
- **Конфиг:** `~/.ralpix/` (global), `./.ralpix/` (project-local override), bundled defaults (внутри extension)
- **Extension:** `~/.pi/agent/extensions/ralpix/index.ts`
- **Bootstrap:** при первом запуске extension копирует bundled defaults в `~/.ralpix/`
- **Формат плана:** ralpix-compatible markdown (`# Plan:`, `## Overview`, `### Task N:`, `- [ ]` чекбоксы)
- **Сессии:** `ctx.newSession()` для каждого шага — чистый контекст
- **Review:** запускается автоматически после задач, не является шагом в плане

## Success Criteria

- [ ] Команда `/ralpix docs/plans/feature.md` запускает автономное выполнение
- [ ] Каждый pending task выполняется в новой сессии с настраиваемой моделью
- [ ] После каждого task — auto-commit в текущую ветку
- [ ] Прогресс пишется в `.ralpix/progress/<plan-name>.txt`
- [ ] Чекбоксы в плане обновляются автоматически (`- [ ]` → `- [x]`)
- [ ] Review pipeline запускается после задач (first + second pass)
- [ ] Полностью hands-off: без промптов во время выполнения

---

## Config & Directory Structure

Целевая структура:

```
~/.pi/agent/extensions/ralpix/      # extension bundle (read-only defaults)
├── bundled/
│   ├── config.json
│   ├── prompts/
│   │   ├── task-default.md
│   │   ├── review-first.md
│   │   ├── review-second.md
│   │   └── finalize.md
│   └── agents/
│       ├── quality.md
│       ├── implementation.md
│       ├── testing.md
│       ├── simplification.md
│       └── documentation.md

~/.ralpix/                          # global (копия bundled при init)
├── config.json
├── prompts/
│   ├── task-default.md
│   ├── review-first.md
│   ├── review-second.md
│   └── finalize.md
├── agents/
│   ├── quality.md
│   ├── implementation.md
│   ├── testing.md
│   ├── simplification.md
│   └── documentation.md
└── progress/

./.ralpix/                          # project-local (переопределяет global)
├── config.json
└── prompts/
    └── task-default.md             # кастомный промпт для проекта
```

**Приоритет загрузки (по убыванию):** `~/.ralpix/` → bundled defaults внутри extension. Project-local `./.ralpix/` мержится поверх global.

### Task 1: Bootstrap directory structure, init command, and config schema

Создать глобальную структуру директорий, bundled defaults и TypeScript-схему конфига.

- [ ] Определить `Config` interface в TypeScript:
  ```typescript
  interface Config {
    defaultModel?: string;           // "anthropic/claude-sonnet-4"
    defaultProvider?: string;
    commitEnabled: boolean;
    commitMessageTemplate: string;   // "ralpix: {{taskName}}"
    reviewEnabled: boolean;
    reviewFirstModel?: string;       // модель для first review
    reviewSecondModel?: string;      // модель для second review
    maxRetries: number;
    movePlanOnCompletion: boolean;
  }
  ```
- [ ] Создать `BUNDLED_DEFAULTS` внутри extension — объект/модули с дефолтным `config.json` и всеми промптами (`task-default.md`, `review-first.md`, `review-second.md`, 5 агентов)
- [ ] Реализовать `initRalpixHome(): Promise<void>`:
  - Проверяет, существует ли `~/.ralpix/`
  - Если нет — создаёт `~/.ralpix/` с подпапками `prompts/`, `agents/`, `progress/`
  - Копирует bundled defaults в `~/.ralpix/`
  - Не перезаписывает существующие файлы (idempotent)
- [ ] Реализовать `loadConfig(cwd: string): Config`:
  - Берёт bundled defaults как базу
  - Если есть `~/.ralpix/config.json` — мержит поверх (deep merge)
  - Если есть `./.ralpix/config.json` — мержит поверх (project overrides global)
  - Применяет дефолты для отсутствующих полей
- [ ] Реализовать `loadPrompt(name: string, cwd: string): string`:
  - Ищет `./.ralpix/prompts/<name>.md` → `~/.ralpix/prompts/<name>.md` → bundled default
- [ ] Реализовать `loadAgent(name: string): string`:
  - Ищет `~/.ralpix/agents/<name>.md` → bundled default
- [ ] Реализовать `saveConfig()` для обновления project-local конфига
- [ ] Написать тестовый `config.json` с разумными дефолтами

### Task 2: Implement plan parser

Парсер markdown-планов в формате ralpix.

- [ ] Реализовать `parsePlan(filePath: string): Plan`
- [ ] Извлекать заголовок (`# Plan: Title`)
- [ ] Извлекать секции: `## Overview`, `## Context`, `## Success Criteria`
- [ ] Извлекать задачи: `### Task N: Title` с вложенными `- [ ]` / `- [x]` чекбоксами
- [ ] Task interface:
  ```typescript
  interface Task {
    id: string;           // "task-1"
    number: number;       // 1
    title: string;
    description: string;  // текст после заголовка до следующего ### или конца
    items: { text: string; done: boolean }[];  // чекбоксы
    status: 'pending' | 'in-progress' | 'completed' | 'failed';
  }
  ```
- [ ] Реализовать `updatePlanTaskStatus(planPath, taskId, status)` — переписывает чекбоксы `- [ ]` → `- [x]` в исходном файле
- [ ] Реализовать `findNextPendingTask(plan): Task | null`
- [ ] Обработать edge case: если чекбоксов нет, считать весь `### Task` одним шагом

### Task 3: Create default prompt templates

Наполнить `~/.ralpix/prompts/` и `~/.ralpix/agents/` дефолтными шаблонами.

- [ ] `~/.ralpix/prompts/task-default.md` — промпт для выполнения задачи:
  ```markdown
  # Task Execution

  You are executing a task from a development plan.

  ## Plan Context
  {{OVERVIEW}}

  ## Current Task
  {{TASK_TITLE}}
  {{TASK_DESCRIPTION}}

  ## Instructions
  - Complete all checklist items for this task
  - Use available tools to read, modify, and test code
  - After completing the task, summarize what was done
  ```
- [ ] `~/.ralpix/prompts/review-first.md` — first review pass (5 агентов):
  ```markdown
  Code review of: {{GOAL}}

  Progress log: {{PROGRESS_FILE}}

  ## Step 1: Get Branch Context
  Run `git log {{DEFAULT_BRANCH}}..HEAD --oneline` and `git diff {{DEFAULT_BRANCH}}...HEAD`

  ## Step 2: Launch ALL 5 Review Agents IN PARALLEL
  Agents: {{agent:quality}}, {{agent:implementation}}, {{agent:testing}}, {{agent:simplification}}, {{agent:documentation}}
  ```
- [ ] `~/.ralpix/prompts/review-second.md` — second review pass (2 агента):
  ```markdown
  Second code review pass of: {{GOAL}}

  Agents: {{agent:quality}}, {{agent:implementation}}
  Focus only on critical and major issues.
  ```
- [ ] Создать 5 agent-промптов в `~/.ralpix/agents/`:
  - `quality.md` — correctness, security, edge cases
  - `implementation.md` — verifies code achieves stated goals
  - `testing.md` — test coverage and quality
  - `simplification.md` — detects over-engineering
  - `documentation.md` — checks if docs need updates
- [ ] Реализовать `loadPrompt(templatePath, variables): string` — подстановка `{{VAR}}` из объекта
- [ ] Реализовать `expandAgents(prompt, agentsDir): string` — замена `{{agent:name}}` на содержимое файла

### Task 4: Build core extension entry point

Создать `~/.pi/agent/extensions/ralpix/index.ts` — точка входа extension.

- [ ] Экспортировать `default function (pi: ExtensionAPI)`
- [ ] Зарегистрировать команду `/ralpix init`:
  - Выводит `ctx.ui.confirm("Initialize ralpix?", "Create ~/.ralpix/ with default prompts and config?")`
  - Если подтверждено — вызывает `initRalpixHome()`
  - Idempotent: не ломает существующие файлы
- [ ] Зарегистрировать команду `/ralpix <path-to-plan.md>`:
  - **Auto-init:** если `~/.ralpix/` не существует — вызвать `initRalpixHome()` автоматически (с `ctx.ui.notify()`)
  - Валидация: файл существует, это git-репозиторий
  - Загрузка конфига (`loadConfig`), парсинг плана
  - Инициализация progress log
- [ ] Зарегистрировать tool `ralpix_mark_task_done`:
  ```typescript
  pi.registerTool({
    name: "ralpix_mark_task_done",
    parameters: Type.Object({ taskId: Type.String() }),
    execute: async (id, params) => { /* обновить статус в state */ }
  });
  ```
- [ ] Написать `ProgressLogger` класс:
  - Путь: `.ralpix/progress/<plan-stem>.txt`
  - Методы: `logStart(plan)`, `logTaskStart(task)`, `logTaskEnd(task, result)`, `logReview(phase, result)`
- [ ] Persist state через `pi.appendEntry("ralpix-state", {...})` для восстановления после прерывания

### Task 5: Implement task execution engine

Движок выполнения задач в изолированных сессиях.

- [ ] Реализовать `executeTask(task, config, plan, progressLogger): Promise<Result>`
- [ ] Алгоритм для каждой задачи:
  1. Определить модель: `task.model` (из плана, если будем поддерживать) → `config.defaultModel`
  2. Загрузить промпт: `./.ralpix/prompts/task-default.md` → `~/.ralpix/prompts/task-default.md`
  3. Подставить переменные (`{{TASK_TITLE}}`, `{{OVERVIEW}}`, etc.)
  4. Создать новую сессию: `ctx.newSession({ withSession: async (newCtx) => { ... } })`
  5. В новой сессии:
     - Прочитать `.ralpix/progress/<plan>.txt` и добавить в контекст (если нужна история)
     - Отправить промпт: `newCtx.sendUserMessage(prompt)`
     - Дождаться: `await newCtx.waitForIdle()`
  6. Определить результат: success (agent завершился без ошибок) / failed
  7. Вернуться в основную сессию
- [ ] После success: auto-commit через bash tool
  ```typescript
  // в newSession с bash tool доступен
  await bash("git add -A && git commit -m 'ralpix: Task N - title'")
  ```
- [ ] Обновить чекбоксы в плане через `updatePlanTaskStatus`
- [ ] Записать в progress log
- [ ] Retry logic: при failure повторить до `config.maxRetries`
- [ ] При исчерпании retries: остановиться, оставить task как failed

**Важный нюанс:** `ctx.newSession()` в pi переключает **текущую** сессию. После возврата из `withSession` мы снова в старой сессии. Это корректно для последовательного выполнения.

### Task 6: Implement review pipeline

Review запускается после завершения всех задач.

- [ ] Реализовать `runReview(phase: 'first' | 'second', config, plan, progress)`
- [ ] **Phase 1 — First Review:**
  - Загрузить `review-first.md` промпт
  - Подставить `{{agent:*}}` из `~/.ralpix/agents/`
  - Определить review-модель: `config.reviewFirstModel` → `config.defaultModel`
  - Запустить **5 параллельных суб-сессий** (по одной на агента):
    - Для параллелизма использовать паттерн `Promise.all()` с `newSession()`
    - **Проблема:** `newSession()` заменяет текущую сессию, параллельный запуск невозможен напрямую.
    - **Решение:** Использовать `pi.exec()` для запуска отдельных pi-процессов (как в `subagent` примере) с флагом `--model` и `--mode json`, ИЛИ запускать последовательно.
    - **Для MVP:** запускать последовательно, но в отдельных сессиях. Параллелизм — в v2.
  - Каждая review-сессия получает промпт агента + контекст git diff
  - Собрать результаты всех 5 агентов
  - Если есть issues: создать fix-сессию с review-моделью, передать findings, дать исправить, закоммитить
  - Итерировать до clean или max iterations
- [ ] **Phase 2 — Second Review:**
  - Аналогично, но с `review-second.md` и 2 агентами
  - Модель: `config.reviewSecondModel`
- [ ] После review: записать summary в progress log

### Task 7: Git integration and plan lifecycle

Git-операции и управление жизненным циклом плана.

- [ ] Реализовать `commitChanges(message: string)`:
  - Использовать bash tool: `git add -A && git commit -m "message"`
  - Если `commitEnabled: false` — пропустить
- [ ] Шаблон сообщения коммита: заменить `{{taskName}}`, `{{taskNumber}}` на реальные значения
- [ ] Если `movePlanOnCompletion`:
  - Создать директорию `<plan-dir>/completed/`
  - Переместить план туда: `mv plan.md completed/plan.md`
- [ ] Записать финальный статус в progress log

### Task 8: Error handling, resume, and UI feedback

Обработка ошибок, восстановление после прерывания и UI.

- [ ] На `session_start`: восстановить ralpix-state из `pi.appendEntry` entries
- [ ] Если выполнение было прервано:
  - Прочитать план и найти последний completed task
  - Продолжить с next pending task
- [ ] UI статус:
  ```typescript
  ctx.ui.setStatus("ralpix", `Task ${current}/${total}`);
  ctx.ui.setWidget("ralpix", [
    `Plan: ${planTitle}`,
    `Phase: ${phase}`,
    `Progress: ${completed}/${total}`,
    ...tasks.map(t => `${t.done ? '✓' : '○'} ${t.title}`)
  ]);
  ```
- [ ] `ctx.ui.notify()` на переходах между фазами
- [ ] Обработка SIGINT/SIGTERM: graceful shutdown, сохранить state

### Task 9: Test end-to-end with a sample plan

E2E тестирование на реальном плане.

- [ ] Создать тестовый git-репозиторий в `/tmp/ralpix-test-repo/`
- [ ] Написать тестовый план `test-plan.md` с 2-3 простыми задачами (например, создать файл, отредактировать файл)
- [ ] Запустить `/ralpix test-plan.md`
- [ ] Проверить:
  - [ ] Все задачи выполнены
  - [ ] Чекбоксы обновлены
  - [ ] Коммиты созданы (`git log`)
  - [ ] Progress log записан
  - [ ] Review pipeline запустился (если enabled)
- [ ] Задокументировать найденные баги

### Task 10: Documentation

Документация для пользователя.

- [ ] Написать `~/.ralpix/README.md`:
  - Описание директорий
  - Формат `config.json` с примерами
  - Как писать планы (формат markdown)
  - Как кастомизировать промпты и агентов
  - Как выбирать модель для review
- [ ] Написать пример плана `example-plan.md`
- [ ] Добавить troubleshooting section

---

## Open Questions / v2 Ideas

- **Parallel review:** Использовать `spawn()` с `pi --mode json` для параллельных review-агентов (как subagent пример)
- **Worktree isolation:** `--worktree` флаг для изолированных git worktree
- **Validation commands:** `## Validation Commands` в плане с авто-запуском после шага
- **Per-task model override:** YAML frontmatter в плане или `<!-- model: gemini -->` комментарии
- **Web dashboard:** `--serve` флаг для просмотра прогресса в браузере
- **Notifications:** Telegram/Slack хук на завершение/фейл
