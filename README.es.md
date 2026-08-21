<p align="center">
  <img src="assets/banner.png" alt="Eternal Agent" width="100%">
</p>

# Eternal Agent ☤

<p align="center">
  <a href="website/docs/"><img src="https://img.shields.io/badge/Docs-en%20este%20repo-FFD700?style=for-the-badge" alt="Documentación"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Licencia-MIT-green?style=for-the-badge" alt="Licencia: MIT"></a>
  <a href="https://github.com/NousResearch/hermes-agent"><img src="https://img.shields.io/badge/Fork%20de-Hermes%20Agent-lightgrey?style=for-the-badge" alt="Fork de Hermes Agent"></a>
  <a href="README.md"><img src="https://img.shields.io/badge/Lang-English-blue?style=for-the-badge" alt="English"></a>
  <a href="README.zh-CN.md"><img src="https://img.shields.io/badge/Lang-中文-red?style=for-the-badge" alt="中文"></a>
  <a href="README.ur-pk.md"><img src="https://img.shields.io/badge/Lang-اردو-green?style=for-the-badge" alt="اردو"></a>
</p>

> **Eternal es un fork de [Hermes Agent](https://github.com/NousResearch/hermes-agent), usado bajo la Licencia MIT.**
> **No está afiliado a, respaldado por, ni soportado por Nous Research.** No reportes incidencias,
> solicitudes de soporte ni errores de Eternal al proyecto original. La atribución de la obra
> original se conserva en [`LICENSE`](LICENSE) y [`NOTICE`](NOTICE).

**El agente de IA con mejora continua.** Es el único agente con un bucle de aprendizaje integrado: crea habilidades a partir de la experiencia, las mejora durante el uso, se impulsa a sí mismo a persistir el conocimiento, busca en sus propias conversaciones pasadas y construye un modelo cada vez más profundo de quién eres a lo largo de las sesiones. Ejecútalo en un VPS de $5, un clúster de GPUs o infraestructura sin servidor que cuesta casi nada cuando está inactivo. No está atado a tu laptop — habla con él desde Telegram mientras trabaja en una VM en la nube.

Usa cualquier modelo que quieras — [OpenRouter](https://openrouter.ai) (más de 200 modelos), [NovitaAI](https://novita.ai), [NVIDIA NIM](https://build.nvidia.com) (Nemotron), [Xiaomi MiMo](https://platform.xiaomimimo.com), [z.ai/GLM](https://z.ai), [Kimi/Moonshot](https://platform.moonshot.ai), [MiniMax](https://www.minimax.io), [Hugging Face](https://huggingface.co), OpenAI, o tu propio endpoint. Cambia con `eternal model` — sin cambios de código, sin dependencias.

<table>
<tr><td><b>Una interfaz de terminal real</b></td><td>TUI completa con edición multilínea, autocompletado de comandos, historial de conversaciones, interrupción y redirección, y salida de herramientas en streaming.</td></tr>
<tr><td><b>Vive donde tú vives</b></td><td>Telegram, Discord, Slack, WhatsApp, Signal y CLI — todo desde un único proceso gateway. Transcripción de notas de voz, continuidad de conversación entre plataformas.</td></tr>
<tr><td><b>Un bucle de aprendizaje cerrado</b></td><td>Memoria curada por el agente con recordatorios periódicos. Creación autónoma de habilidades tras tareas complejas. Las habilidades mejoran solas durante el uso. Búsqueda FTS5 de sesiones con resumención por LLM para recuperación entre sesiones. Modelado de usuario dialéctico <a href="https://github.com/plastic-labs/honcho">Honcho</a>. Compatible con el estándar abierto de <a href="https://agentskills.io">agentskills.io</a>.</td></tr>
<tr><td><b>Automatizaciones programadas</b></td><td>Planificador cron integrado con entrega a cualquier plataforma. Informes diarios, copias de seguridad nocturnas, auditorías semanales — todo en lenguaje natural, ejecutándose de forma autónoma.</td></tr>
<tr><td><b>Delega y paraleliza</b></td><td>Lanza subagentes aislados para flujos de trabajo paralelos. Escribe scripts de Python que llaman a herramientas vía RPC, convirtiendo pipelines de múltiples pasos en turnos de coste cero de contexto.</td></tr>
<tr><td><b>Funciona en cualquier lugar, no solo en tu laptop</b></td><td>Seis backends de terminal — local, Docker, SSH, Singularity, Modal y Daytona. Daytona y Modal ofrecen persistencia sin servidor — el entorno de tu agente hiberna cuando está inactivo y se activa bajo demanda, costando casi nada entre sesiones. Ejecútalo en un VPS de $5 o un clúster de GPUs.</td></tr>
<tr><td><b>Listo para investigación</b></td><td>Generación de trayectorias en lote, compresión de trayectorias para entrenar la próxima generación de modelos de llamadas a herramientas.</td></tr>
</table>

---

## Instalación rápida

### Linux, macOS, WSL2, Termux

```bash
scripts/install.sh
```

### Windows (nativo, PowerShell)

> **Nota:** En Windows nativo, Eternal funciona sin WSL — la CLI, el gateway, la TUI y las herramientas funcionan de forma nativa. Si prefieres usar WSL2, el comando de Linux/macOS de arriba también funciona allí. ¿Encontraste un error? Por favor [crea un issue](https://github.com/riddhimaaan/eternal/issues).

Ejecuta esto en PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

El instalador se encarga de todo: uv, Python 3.11, Node.js, ripgrep, ffmpeg, **y un Git Bash portátil** (MinGit, descomprimido en `%LOCALAPPDATA%\eternal\git` — no requiere administrador, completamente aislado de cualquier instalación de Git del sistema). Eternal usa este Git Bash incluido para ejecutar comandos de shell.

Si ya tienes Git instalado, el instalador lo detecta y lo usa en su lugar. De lo contrario, una descarga de ~45MB de MinGit es todo lo que necesitas — no tocará ni interferirá con ningún Git del sistema.

> **Android / Termux:** La ruta manual probada está documentada en la [guía de Termux](website/docs/getting-started/termux.md). En Termux, Eternal instala el extra `.[termux]` curado porque el extra completo `.[all]` actualmente incluye dependencias de voz incompatibles con Android.
>
> **Windows:** Windows nativo es totalmente compatible — el comando de PowerShell de arriba instala todo. Si prefieres usar WSL2, el comando de Linux también funciona allí. La instalación nativa de Windows se encuentra en `%LOCALAPPDATA%\eternal`; WSL2 instala en `~/.eternal` como en Linux.

Después de la instalación:

```bash
source ~/.bashrc    # recargar shell (o: source ~/.zshrc)
eternal              # ¡empieza a chatear!
```

---

## Primeros pasos

```bash
eternal              # CLI interactiva — inicia una conversación
eternal model        # Elige tu proveedor y modelo LLM
eternal tools        # Configura qué herramientas están habilitadas
eternal config set   # Establece valores de configuración individuales
eternal gateway      # Inicia el gateway de mensajería (Telegram, Discord, etc.)
eternal setup        # Ejecuta el asistente de configuración completo
eternal claw migrate # Migra desde OpenClaw (si vienes de OpenClaw)
eternal update       # Actualiza a la última versión
eternal doctor       # Diagnostica cualquier problema
```

📖 **[Documentación completa →](website/docs/)**

---

## Referencia rápida: CLI vs Mensajería

Eternal tiene dos puntos de entrada: inicia la interfaz de terminal con `eternal`, o ejecuta el gateway y habla con él desde Telegram, Discord, Slack, WhatsApp, Signal o Email. Una vez en una conversación, muchos comandos de barra son compartidos entre ambas interfaces.

| Acción                              | CLI                                           | Plataformas de mensajería                                                         |
| ----------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| Empezar a chatear                   | `eternal`                                      | Ejecuta `eternal gateway setup` + `eternal gateway start`, luego envía un mensaje al bot |
| Nueva conversación                  | `/new` o `/reset`                             | `/new` o `/reset`                                                                 |
| Cambiar modelo                      | `/model [proveedor:modelo]`                   | `/model [proveedor:modelo]`                                                       |
| Establecer personalidad             | `/personality [nombre]`                       | `/personality [nombre]`                                                           |
| Reintentar o deshacer último turno  | `/retry`, `/undo`                             | `/retry`, `/undo`                                                                 |
| Comprimir contexto / ver uso        | `/compress`, `/usage`, `/insights [--days N]` | `/compress`, `/usage`, `/insights [days]`                                         |
| Explorar habilidades                | `/skills` o `/<nombre-habilidad>`             | `/<nombre-habilidad>`                                                             |
| Interrumpir trabajo actual          | `Ctrl+C` o enviar un nuevo mensaje            | `/stop` o enviar un nuevo mensaje                                                 |
| Estado específico de plataforma     | `/platforms`                                  | `/status`, `/sethome`                                                             |

Para las listas de comandos completas, consulta la [guía de CLI](website/docs/user-guide/cli.md) y la [guía del Gateway de Mensajería](website/docs/user-guide/messaging/).

---

## Documentación

Toda la documentación está en **[`website/docs/`](website/docs/)**:

| Sección                                                                                             | Contenido                                                    |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [Inicio rápido](website/docs/getting-started/quickstart.md)              | Instalar → configurar → primera conversación en 2 minutos   |
| [Uso de CLI](website/docs/user-guide/cli.md)                             | Comandos, atajos de teclado, personalidades, sesiones        |
| [Configuración](website/docs/user-guide/configuration.md)               | Archivo de configuración, proveedores, modelos, todas las opciones |
| [Gateway de Mensajería](website/docs/user-guide/messaging/)           | Telegram, Discord, Slack, WhatsApp, Signal, Home Assistant   |
| [Seguridad](website/docs/user-guide/security.md)                        | Aprobación de comandos, emparejamiento por DM, aislamiento en contenedor |
| [Herramientas y Toolsets](website/docs/user-guide/features/tools.md)   | Más de 40 herramientas, sistema de toolsets, backends de terminal |
| [Sistema de Habilidades](website/docs/user-guide/features/skills.md)   | Memoria procedimental, Skills Hub, creación de habilidades   |
| [Memoria](website/docs/user-guide/features/memory.md)                   | Memoria persistente, perfiles de usuario, mejores prácticas  |
| [Integración MCP](website/docs/user-guide/features/mcp.md)              | Conecta cualquier servidor MCP para capacidades extendidas   |
| [Programación Cron](website/docs/user-guide/features/cron.md)           | Tareas programadas con entrega a plataforma                  |
| [Archivos de Contexto](website/docs/user-guide/features/context-files.md) | Contexto de proyecto que da forma a cada conversación      |
| [Arquitectura](website/docs/developer-guide/architecture.md)            | Estructura del proyecto, bucle del agente, clases principales |
| [Contribuir](website/docs/developer-guide/contributing.md)              | Configuración de desarrollo, proceso de PR, estilo de código |
| [Referencia de CLI](website/docs/reference/cli-commands.md)             | Todos los comandos y flags                                   |
| [Variables de Entorno](website/docs/reference/environment-variables.md) | Referencia completa de variables de entorno                  |

---

## Migración desde OpenClaw

Si vienes de OpenClaw, Eternal puede importar automáticamente tu configuración, memorias, habilidades y claves API.

**Durante la configuración inicial:** El asistente de configuración (`eternal setup`) detecta automáticamente `~/.openclaw` y ofrece migrar antes de que comience la configuración.

**En cualquier momento después de instalar:**

```bash
eternal claw migrate              # Migración interactiva (preset completo)
eternal claw migrate --dry-run    # Vista previa de qué se migraría
eternal claw migrate --preset user-data   # Migrar sin secretos
eternal claw migrate --overwrite  # Sobreescribir conflictos existentes
```

Qué se importa:

- **SOUL.md** — archivo de personalidad
- **Memorias** — entradas de MEMORY.md y USER.md
- **Habilidades** — habilidades creadas por el usuario → `~/.eternal/skills/openclaw-imports/`
- **Lista de comandos permitidos** — patrones de aprobación
- **Configuración de mensajería** — configuración de plataformas, usuarios permitidos, directorio de trabajo
- **Claves API** — secretos en lista de permitidos (Telegram, OpenRouter, OpenAI, Anthropic, ElevenLabs)
- **Assets de TTS** — archivos de audio del espacio de trabajo
- **Instrucciones del espacio de trabajo** — AGENTS.md (con `--workspace-target`)

Consulta `eternal claw migrate --help` para todas las opciones, o usa la habilidad `openclaw-migration` para una migración guiada interactiva por el agente con vistas previas de dry-run.

---

## Contribuir

¡Las contribuciones son bienvenidas! Consulta la [Guía de Contribución](CONTRIBUTING.es.md) para la configuración del desarrollo, el estilo de código y el proceso de PR.

Inicio rápido para colaboradores — clona y comienza con `setup-eternal.sh`:

```bash
git clone https://github.com/riddhimaaan/eternal.git
cd eternal
./setup-eternal.sh     # instala uv, crea venv, instala .[all], enlaza ~/.local/bin/eternal
./eternal              # detecta automáticamente el venv, no necesitas hacer `source` primero
```

Ruta manual (equivalente a lo anterior):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv venv .venv --python 3.11
source .venv/bin/activate
uv pip install -e ".[all,dev]"
scripts/run_tests.sh
```

---

## Comunidad

- 📚 [Skills Hub](https://agentskills.io)
- 🐛 [Issues](https://github.com/riddhimaaan/eternal/issues)
- 🔌 [computer-use-linux](https://github.com/avifenesh/computer-use-linux) — Servidor MCP de control de escritorio Linux para Eternal y otros hosts MCP, con árboles de accesibilidad AT-SPI, entrada Wayland/X11, capturas de pantalla y targeting de ventanas del compositor.
- 🔌 [EternalClaw](https://github.com/AaronWong1999/eternalclaw) — Puente WeChat comunitario: Ejecuta Eternal Agent y OpenClaw en la misma cuenta de WeChat.

---

## Licencia

MIT — ver [LICENSE](LICENSE) y [NOTICE](NOTICE).

Eternal es un fork de [Hermes Agent](https://github.com/NousResearch/hermes-agent), creado
originalmente por Nous Research y usado bajo la Licencia MIT. Eternal no está afiliado a,
respaldado por, ni soportado por Nous Research.
