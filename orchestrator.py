import os
import time
import json
import hashlib
import requests
from requests.exceptions import RequestException

import db

# --- CONFIGURATION LOADING ---
config = None

def load_config(config_path="config.py"):
    """
    Loads configuration from a Python file.
    Returns a dictionary with configuration values.
    """
    global config

    if not os.path.exists(config_path):
        print(f"Error: Config file '{config_path}' not found.")
        print(f"Please copy 'config.example.py' to 'config.py' and configure your settings.")
        return None

    try:
        # Import the config module
        import importlib.util
        spec = importlib.util.spec_from_file_location("config", config_path)
        config_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(config_module)

        # Extract configuration as dictionary
        loaded_config = {
            'api_url': getattr(config_module, 'API_URL', None),
            'api_key': getattr(config_module, 'API_KEY', ''),
            'db_path': getattr(config_module, 'DB_PATH', './orchestra.db'),
            'request_timeout': getattr(config_module, 'REQUEST_TIMEOUT', 300),
            'default_model': getattr(config_module, 'DEFAULT_MODEL', 'llama3'),
            'default_workspace': getattr(config_module, 'DEFAULT_WORKSPACE', None),
        }

        # Validate required configuration
        required_keys = ['api_url', 'api_key', 'db_path', 'request_timeout', 'default_model', 'default_workspace']
        for key in required_keys:
            if loaded_config.get(key) is None:
                print(f"Error: Missing or invalid configuration for '{key}' in config.py")
                return None

        config = loaded_config
        return config
    except Exception as e:
        print(f"Error loading config file: {e}")
        return None

def get_config():
    """
    Returns the loaded configuration dictionary.
    Loads config if not already loaded.
    """
    global config
    if config is None:
        config = load_config()
    return config

def check_completion_criteria(response_text, criteria):
    """
    Evaluates the LLM response against the criteria defined for the task.
    `criteria` may be None, a string, or a dict (parsed from stored JSON).
    """
    if not criteria:
        # If no criteria, assume completion if we got a response
        return True

    if isinstance(criteria, str):
        # Simple string match (legacy support)
        return criteria.lower() in response_text.lower()

    if isinstance(criteria, dict):
        # Check for 'contains' string
        if 'contains' in criteria:
            if criteria['contains'].lower() not in response_text.lower():
                return False

        # Check for 'min_length'
        if 'min_length' in criteria:
            if len(response_text) < criteria['min_length']:
                return False

        return True

    return False

def parse_completion_criteria(raw):
    """
    Normalizes the stored completion_criteria value into something
    check_completion_criteria understands (None, str, or dict).
    """
    if raw is None:
        return None
    if isinstance(raw, (dict, str)) is False:
        return None
    if isinstance(raw, dict):
        return raw
    # Stored as text — try JSON, fall back to raw string.
    raw = raw.strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return raw

def submit_to_openwebui(model, content, workspace_id=None):
    """
    Sends the prompt to the OpenWebUI API.
    Returns tuple: (content, log_data)
    - content: The response message content (or None on error)
    - log_data: Dictionary with detailed logging information (or None on success)
    """
    cfg = get_config()
    if cfg is None:
        error_log = {
            'timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
            'stage': 'Configuration',
            'error': 'Configuration not loaded'
        }
        print(f"Error: {error_log['error']}")
        return None, error_log

    headers = {
        "Content-Type": "application/json"
    }

    if cfg.get('api_key'):
        headers["Authorization"] = f"Bearer {cfg['api_key']}"

    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": content}
        ],
        "stream": False
    }

    if workspace_id:
        headers["X-Workspace-ID"] = workspace_id

    # Log request details
    request_log = {
        'timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
        'stage': 'API Request',
        'url': cfg['api_url'],
        'method': 'POST',
        'model': model,
        'workspace': workspace_id,
        'headers': {
            k: v if k != 'Authorization' else 'Bearer [REDACTED]'
            for k, v in headers.items()
        },
        'payload_size': len(json.dumps(payload)),
        'timeout': cfg['request_timeout']
    }

    try:
        start_time = time.time()
        response = requests.post(cfg['api_url'], headers=headers, json=payload, timeout=cfg['request_timeout'])
        elapsed_time = time.time() - start_time

        response_log = {
            'timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
            'stage': 'API Response',
            'status_code': response.status_code,
            'response_time_seconds': round(elapsed_time, 2),
            'response_headers': dict(response.headers),
            'response_size': len(response.text)
        }

        response.raise_for_status()
        data = response.json()

        # Extract content from standard OpenAI format response
        content = data['choices'][0]['message']['content']
        return content, None

    except RequestException as e:
        error_log = {
            **request_log,
            'timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
            'stage': 'API Error',
            'error_type': type(e).__name__,
            'error_message': str(e),
            'response_text': response.text if 'response' in locals() else 'No response available'
        }
        print(f"API Error: {error_log}")
        return None, error_log
    except (KeyError, IndexError) as e:
        error_log = {
            **request_log,
            'timestamp': time.strftime("%Y-%m-%d %H:%M:%S"),
            'stage': 'Response Parsing Error',
            'error_type': type(e).__name__,
            'error_message': str(e),
            'response_text': response.text if 'response' in locals() else 'No response available'
        }
        print(f"Parsing Error: {error_log}")
        return None, error_log

def format_error_log(log_data):
    """
    Formats error log data into readable markdown text.
    """
    lines = ["## Error Log\n\n"]

    # If log_data is a single log entry (dict), format it directly
    if isinstance(log_data, dict) and 'stage' in log_data:
        lines.append(f"### {log_data['stage']}\n")
        for key, value in log_data.items():
            if key == 'stage':
                continue  # Already used as header
            elif key == 'headers' or key == 'response_headers':
                lines.append(f"**{key}:**\n```\n{json.dumps(value, indent=2)}\n```\n")
            elif key == 'response_text' or key == 'error_message':
                lines.append(f"**{key}:**\n```\n{value}\n```\n")
            else:
                lines.append(f"**{key}:** {value}\n")
    else:
        # If log_data is multiple stages, format each
        for stage, data in log_data.items():
            lines.append(f"### {stage}\n")
            for key, value in data.items():
                if key == 'headers' or key == 'response_headers':
                    lines.append(f"**{key}:**\n```\n{json.dumps(value, indent=2)}\n```\n")
                elif key == 'response_text' or key == 'error_message':
                    lines.append(f"**{key}:**\n```\n{value}\n```\n")
                else:
                    lines.append(f"**{key}:** {value}\n")
            lines.append("\n")

    return '\n'.join(lines)

def generate_task_id(timestamp):
    """
    Generates a task ID by creating a SHA256 hash of the timestamp.
    Returns the full hash and first 6 characters.
    """
    hash_obj = hashlib.sha256(timestamp.encode('utf-8'))
    full_hash = hash_obj.hexdigest()
    short_hash = full_hash[:6]
    return full_hash, short_hash

def parse_evaluator_response(evaluator_response):
    """
    Parses the evaluator's response to extract JSON data.
    Returns tuple: (json_data, error_message)
    """
    # Try to find JSON in the response
    # Look for JSON blocks (```json ... ```) or just raw JSON
    try:
        # Try direct JSON parse first
        json_data = json.loads(evaluator_response)
        return json_data, None
    except json.JSONDecodeError:
        pass

    # Try to find JSON in code blocks
    json_start = evaluator_response.find('```json')
    if json_start != -1:
        json_start += 7  # Skip '```json'
        json_end = evaluator_response.find('```', json_start)
        if json_end != -1:
            json_text = evaluator_response[json_start:json_end].strip()
            try:
                json_data = json.loads(json_text)
                return json_data, None
            except json.JSONDecodeError:
                pass

    # Try to find JSON between { and }
    brace_start = evaluator_response.find('{')
    if brace_start != -1:
        brace_end = evaluator_response.rfind('}')
        if brace_end != -1 and brace_end > brace_start:
            json_text = evaluator_response[brace_start:brace_end + 1]
            try:
                json_data = json.loads(json_text)
                return json_data, None
            except json.JSONDecodeError:
                pass

    return None, "Could not parse JSON from evaluator response"

def create_subtask(parent_task, evaluator_response):
    """
    Creates a new evaluation subtask row with the evaluator's response.
    Returns the created task dict.
    """
    cfg = get_config()

    subtask = db.create_task(
        name=f"{parent_task['name']}_eval",
        content=evaluator_response,
        status='pending',
        model=parent_task.get('model') or cfg.get('default_model', 'llama3'),
        workspace='evaluator',
        parent_task_id=parent_task['task_id'],
        task_type='evaluation',
    )

    print(f"Created evaluation subtask: {subtask['name']} (#{subtask['id']})")
    return subtask

def create_next_steps_subtasks(parent_task, next_steps):
    """
    Creates subtask rows for each item in the next_steps array.
    Returns list of created task dicts.
    """
    cfg = get_config()
    created = []

    for i, step in enumerate(next_steps):
        subtask = db.create_task(
            name=f"{parent_task['name']}_step{i + 1}",
            content=str(step),
            status='pending',
            model=parent_task.get('model') or cfg.get('default_model', 'llama3'),
            workspace=parent_task.get('workspace') or cfg.get('default_workspace'),
            parent_task_id=parent_task['task_id'],
            task_type='next_step',
            step_number=i + 1,
        )
        print(f"Created next step subtask: {subtask['name']} (#{subtask['id']})")
        created.append(subtask)

    return created

def process_task(task):
    """
    Executes a pending task and records its resulting state in the database.
    Task "movement" is a status UPDATE — no files are moved.
    After successful completion, sends the response to the evaluator
    workspace and creates subtasks as needed.
    """
    print(f"--- Processing #{task['id']} {task['name']} ---")

    # 1. Check status
    current_status = task.get('status', 'pending')

    if current_status in ('complete', 'failed'):
        print(f"Task already terminal ({current_status}). Skipping.")
        return

    if current_status == 'running':
        print("Skipping: Task currently marked as running (might be handled by another process).")
        return

    # 2. Extract fields (with fallback to config defaults)
    cfg = get_config()
    model = task.get('model') or cfg.get('default_model', 'llama3')
    workspace = task.get('workspace') or cfg.get('default_workspace')
    criteria = parse_completion_criteria(task.get('completion_criteria'))
    content = task.get('content') or ''

    # 3. Claim the task by marking it 'running' to prevent double execution.
    db.update_task(task['id'], status='running')

    # 4. Execute task (acceptance criteria is stored separately and never sent)
    print(f"Submitting to model '{model}' in workspace '{workspace}'...")
    llm_response, log_data = submit_to_openwebui(model, content, workspace)

    # 5. Evaluate results and record the new state.
    if llm_response:
        print("Response received. Checking criteria...")
        if check_completion_criteria(llm_response, criteria):
            print("Criteria met. Marking as COMPLETE.")
            db.update_task(task['id'], status='complete', response=llm_response, failure_reason=None)
        else:
            print("Criteria NOT met. Marking as INCOMPLETE.")
            db.update_task(
                task['id'],
                status='incomplete',
                response=llm_response,
                failure_reason='Completion criteria not met',
            )
    else:
        print("No response received from API. Marking as FAILED.")
        db.update_task(
            task['id'],
            status='failed',
            response=format_error_log(log_data),
            failure_reason='API Request Failed',
        )

    # 6. On completion, run the evaluator pass and spawn any subtasks.
    updated = db.get_task(task['id'])
    if updated and updated.get('status') == 'complete':
        print("Sending response to evaluator workspace...")
        evaluator_response, evaluator_log = submit_to_openwebui(model, llm_response, 'evaluator')

        if evaluator_response:
            print("Evaluator response received. Parsing response...")
            json_data, parse_error = parse_evaluator_response(evaluator_response)

            if json_data:
                print("Successfully parsed evaluator response JSON")
                acceptance_status = str(json_data.get('acceptance_status', '')).lower()
                print(f"Acceptance status: {acceptance_status}")

                if acceptance_status == 'no':
                    next_steps = json_data.get('NEXT STEPS', json_data.get('next_steps', []))
                    if next_steps and isinstance(next_steps, list) and len(next_steps) > 0:
                        print(f"Found {len(next_steps)} next steps. Creating subtasks...")
                        create_next_steps_subtasks(updated, next_steps)
                    else:
                        print("No next steps found in evaluator response")

                # Always create the evaluation subtask with full response
                create_subtask(updated, evaluator_response)
            else:
                print(f"Could not parse evaluator response as JSON: {parse_error}")
                # Still create subtask with raw response
                create_subtask(updated, evaluator_response)
        else:
            print(f"Warning: Failed to get evaluator response: {evaluator_log.get('error_message', 'Unknown error') if evaluator_log else 'No log available'}")

def main():
    # Load configuration
    cfg = get_config()
    if cfg is None:
        print("Error: Failed to load configuration. Please create config.py from config.example.py")
        return

    db.init_db()

    # Get all pending tasks from the database
    pending_tasks = db.list_tasks(status='pending')

    if not pending_tasks:
        print("No pending tasks found.")
        return

    for task in pending_tasks:
        process_task(task)

if __name__ == "__main__":
    main()
