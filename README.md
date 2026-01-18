# Orchestra

Orchestra is a task orchestration system that processes markdown-based task files and submits them to OpenWebUI-compatible LLM APIs for execution. It tracks task status, validates completion criteria, and automatically archives completed tasks.

## Features

- **Task Management**: Process markdown task files with frontmatter
- **Status Tracking**: Track tasks through pending, running, complete, incomplete, and failed states
- **Completion Criteria**: Validate responses against configurable criteria (contains string, minimum length)
- **Auto-Archiving**: Automatically move completed tasks to a dedicated completed folder
- **Configurable**: Flexible configuration via Python file
- **No External Dependencies**: Only requires the `requests` library
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
   - `DEFAULT_MODEL`: Default LLM model to use if not specified in task
   - `DEFAULT_WORKSPACE`: Default workspace identifier if not specified in task
   - `TASKS_DIRECTORY`: Base tasks directory
   - `PENDING_DIRECTORY`: Directory containing tasks waiting to be processed
   - `COMPLETED_DIRECTORY`: Directory where completed tasks will be moved
   - `FAILED_DIRECTORY`: Directory where failed tasks will be moved
   - `REQUEST_TIMEOUT`: Timeout in seconds for API requests

3. Create your tasks directory structure:
   ```
   tasks/
     ├── pending/          # Place new tasks here
     │   ├── task1.md
     │   └── task2.md
     ├── completed/        # Successfully completed tasks
     ├── failed/           # Failed tasks
     └── examples/         # Example task templates
   ```

## Task File Format

Tasks are markdown files with frontmatter. See `tasks/examples/sample.md` for a working example.

```markdown
---
model: "gpt-oss:20b"
workspace: "friendo"
status: "pending"
completion_criteria:
  contains: "$"
  min_length: 200
---

Please perform a web search to find the current best price for a 65-inch Sony Bravia OLED TV.

Provide a brief summary of the specifications and list the price found at the top retailer.
```

### Frontmatter Fields

- **model** (optional): The LLM model to use. Falls back to `default_model` from config if not specified
- **workspace** (optional): Workspace identifier for routing. Falls back to `default_workspace` from config if not specified
- **status** (optional): Task status - `pending`, `running`, `complete`, `incomplete`, or `failed` (default: `pending`)
- **completion_criteria** (optional): Object with validation rules
  - `contains`: String that must be present in the response
  - `min_length`: Minimum character length of the response

## Usage

Run the orchestrator:

```bash
python orchestrator.py
```

The script will:
1. Load configuration from `config.py`
2. Scan the pending directory for `.md` files
3. Process each pending task
4. Update task status during processing
5. Validate responses against completion criteria
6. Move completed tasks to the completed folder
7. Move failed tasks to the failed folder

## Task Processing Flow

1. **Pending Task**: Task is read from the pending directory and marked as 'running'
2. **Execution**: Task content is submitted to the configured LLM API
3. **Validation**: Response is checked against completion criteria
4. **Status Update**:
   - ✅ **Complete**: Criteria met → task marked complete and moved to completed folder
   - ⚠️ **Incomplete**: Criteria not met → task marked incomplete (remains in queued)
   - ❌ **Failed**: API error → task marked failed and moved to failed folder
5. **Archive**: 
   - Completed tasks are moved to the completed directory
   - Failed tasks are moved to the failed directory

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

# Directory Configuration
TASKS_DIRECTORY = "./tasks"
PENDING_DIRECTORY = "./tasks/pending"
COMPLETED_DIRECTORY = "./tasks/completed"
FAILED_DIRECTORY = "./tasks/failed"

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
├── orchestrator.py          # Main orchestration script
├── config.py               # Configuration file (not in git)
├── config.example.py       # Configuration template
├── .gitignore              # Git ignore rules
├── README.md               # This file
└── tasks/
    ├── pending/           # Place new tasks here for processing
    ├── completed/         # Successfully completed tasks
    ├── failed/            # Failed tasks
    └── examples/          # Example task templates
```

## Error Handling

The script handles various error scenarios:

- Missing or invalid configuration
- Missing tasks directory
- Malformed task files
- API connection failures
- Invalid frontmatter format
- File system errors

## Requirements

- Python 3.6+
- requests
- Access to an OpenWebUI-compatible API endpoint

## License

MIT
