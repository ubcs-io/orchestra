# Orchestra

Orchestra is a task orchestration system that submits tasks to OpenWebUI-compatible LLM APIs for execution. Tasks and their state live in a SQLite database — a task's lifecycle is tracked entirely by its `status` column, with no files moved on disk.

## Features

- **Task Management**: Create and track tasks in a SQLite database
- **Status Tracking**: Track tasks through pending, running, complete, incomplete, and failed states — "movement" is a status update, not a file move
- **Completion Criteria**: Validate responses against configurable criteria (contains string, minimum length)
- **Web UI**: Flask dashboard to create, view, retry, and delete tasks
- **Configurable**: Flexible configuration via Python file
- **Minimal Dependencies**: Flask + `requests`; storage uses the Python stdlib `sqlite3`
- **OpenWebUI Compatible**: Works with OpenAI-compatible API endpoints

## Installation

1. Clone or download this repository
2. Install required Python dependencies:
   ```bash
   pip install requests
   ```

## Setup

1. Copy the example configuration file:
   ```bash
   cp config.example.py config.py
   ```

2. Edit `config.py` with your settings:
   - `API_URL`: Your OpenWebUI API endpoint
   - `API_KEY`: Your API key (leave empty if authentication is disabled)
   - `DEFAULT_MODEL`: Default LLM model to use if not specified on a task
   - `DEFAULT_WORKSPACE`: Default workspace identifier if not specified on a task
   - `DB_PATH`: Path to the SQLite database file (default `./orchestra.db`)
   - `REQUEST_TIMEOUT`: Timeout in seconds for API requests

The database and its `tasks` table are created automatically on first run of
either `app.py` or `orchestrator.py` — no manual setup required.

## Tasks

Tasks are rows in the `tasks` table. Create them through the web UI (see below),
or programmatically via `db.create_task(...)`.

### Task fields

- **name**: Human-readable label for the task
- **content**: The prompt submitted to the LLM
- **model** (optional): The LLM model to use. Falls back to `DEFAULT_MODEL` if not set
- **workspace** (optional): Workspace identifier for routing. Falls back to `DEFAULT_WORKSPACE`
- **status**: `pending`, `running`, `complete`, `incomplete`, or `failed` (default: `pending`)
- **acceptance_criteria** (optional): Guidance kept with the task but never sent to the LLM
- **completion_criteria** (optional): JSON validation rules
  - `contains`: String that must be present in the response
  - `min_length`: Minimum character length of the response
- **response**: The LLM response (or a formatted error log on failure)

## Usage

Start the web UI:

```bash
python app.py
```

Run the orchestrator (processes all pending tasks once):

```bash
python orchestrator.py
```

The orchestrator will:
1. Load configuration from `config.py`
2. Query the database for tasks with status `pending`
3. Mark each as `running`, then submit its content to the configured LLM API
4. Validate the response against completion criteria
5. Update the task's `status` and store the `response` in the database

## Task Processing Flow

1. **Pending Task**: A pending task is claimed by setting its status to `running`
2. **Execution**: Task content is submitted to the configured LLM API
3. **Validation**: Response is checked against completion criteria
4. **Status Update** (a single database UPDATE — nothing is moved on disk):
   - ✅ **Complete**: Criteria met → status set to `complete`, response stored
   - ⚠️ **Incomplete**: Criteria not met → status set to `incomplete`
   - ❌ **Failed**: API error → status set to `failed`, error log stored as the response

## Configuration

The `config.py` file contains all runtime settings:

```python
# API Configuration
API_URL = "http://192.168.2.1:8080/api/v1/chat/completions"
API_KEY = "sk-12345"  # OpenWebUI Bearer token for authentication

# Default Task Settings
# These are used as fallbacks if tasks don't specify model or workspace
DEFAULT_MODEL = "llama3"
DEFAULT_WORKSPACE = "default"

# Database Configuration
DB_PATH = "./orchestra.db"

# Request Configuration
REQUEST_TIMEOUT = 300  # seconds
```

## Security

- **config.py** contains sensitive information and is excluded from version control via `.gitignore`
- Use `config.example.py` as a template for your configuration
- Never commit `config.py` to version control

## Project Structure

```
orchestra/
├── app.py                  # Flask web UI (dashboard, create/view/retry/delete)
├── orchestrator.py         # Worker: processes pending tasks via the LLM API
├── db.py                   # SQLite persistence (tasks table + helper API)
├── config.py               # Configuration file (not in git)
├── config.example.py       # Configuration template
├── orchestra.db            # SQLite database (not in git, created on first run)
├── templates/              # Jinja2 templates for the web UI
├── .gitignore              # Git ignore rules
└── README.md               # This file
```

## Error Handling

The system handles various error scenarios:

- Missing or invalid configuration
- API connection failures
- Malformed evaluator responses
- Database/file system errors

## Requirements

- Python 3.6+
- Flask
- requests
- Access to an OpenWebUI-compatible API endpoint

## License

MIT
