# Orchestra

Orchestra is a task orchestration system that processes markdown-based task files and submits them to OpenWebUI-compatible LLM APIs for execution. It tracks task status, validates completion criteria, and automatically archives completed tasks.

## Features

- **Task Management**: Process markdown task files with YAML frontmatter
- **Status Tracking**: Track tasks through pending, running, complete, incomplete, and failed states
- **Completion Criteria**: Validate responses against configurable criteria (contains string, minimum length)
- **Auto-Archiving**: Automatically move completed tasks to a dedicated completed folder
- **Configurable**: Flexible configuration via YAML file
- **OpenWebUI Compatible**: Works with OpenAI-compatible API endpoints

## Installation

1. Clone or download this repository
2. Install required Python dependencies:
   ```bash
   pip install requests pyyaml
   ```

## Setup

1. Copy the example configuration file:
   ```bash
   cp config.yaml.example config.yaml
   ```

2. Edit `config.yaml` with your settings:
   - `api_url`: Your OpenWebUI API endpoint
   - `api_key`: Your API key (leave empty if authentication is disabled)
   - `default_model`: Default LLM model to use if not specified in task
   - `default_workspace`: Default workspace identifier if not specified in task
   - `tasks_directory`: Base tasks directory
   - `queued_directory`: Directory containing tasks waiting to be processed
   - `completed_directory`: Directory where completed tasks will be moved
   - `failed_directory`: Directory where failed tasks will be moved
   - `request_timeout`: Timeout in seconds for API requests

3. Create your tasks directory structure:
   ```
   tasks/
     ├── queued/           # Place new tasks here
     │   ├── task1.md
     │   └── task2.md
     ├── completed/        # Successfully completed tasks
     ├── failed/           # Failed tasks
     └── examples/         # Example task templates
   ```

## Task File Format

Tasks are markdown files with YAML frontmatter. See `tasks/examples/sample.md` for a working example.

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
1. Load configuration from `config.yaml`
2. Scan the queued directory for `.md` files
3. Process each pending task
4. Update task status during processing
5. Validate responses against completion criteria
6. Move completed tasks to the completed folder
7. Move failed tasks to the failed folder

## Task Processing Flow

1. **Queued Task**: Task is read from the queued directory and marked as 'running'
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

The `config.yaml` file contains all runtime settings:

```yaml
# API Configuration
api_url: "http://192.168.2.1:8080/api/v1/chat/completions"
api_key: "sk-12345"  # OpenWebUI Bearer token for authentication

# Default Task Settings
# These are used as fallbacks if tasks don't specify model or workspace
default_model: "llama3"
default_workspace: "default"

# Directory Configuration
tasks_directory: "./tasks"
queued_directory: "./tasks/queued"
completed_directory: "./tasks/completed"
failed_directory: "./tasks/failed"

# Request Configuration
request_timeout: 300  # seconds
```

## Security

- **config.yaml** contains sensitive information and is excluded from version control via `.gitignore`
- Use `config.yaml.example` as a template for your configuration
- Never commit `config.yaml` to version control

## Project Structure

```
orchestra/
├── orchestrator.py          # Main orchestration script
├── config.yaml              # Configuration file (not in git)
├── config.yaml.example      # Configuration template
├── .gitignore              # Git ignore rules
├── README.md               # This file
└── tasks/
    ├── queued/            # Place new tasks here for processing
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
- Invalid YAML frontmatter
- File system errors

## Requirements

- Python 3.6+
- requests
- pyyaml
- Access to an OpenWebUI-compatible API endpoint

## License

MIT
