import os
import time
import hashlib
import requests
from requests.exceptions import RequestException

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
            'tasks_directory': getattr(config_module, 'TASKS_DIRECTORY', './tasks'),
            'pending_directory': getattr(config_module, 'PENDING_DIRECTORY', './tasks/pending'),
            'completed_directory': getattr(config_module, 'COMPLETED_DIRECTORY', './tasks/completed'),
            'failed_directory': getattr(config_module, 'FAILED_DIRECTORY', './tasks/failed'),
            'request_timeout': getattr(config_module, 'REQUEST_TIMEOUT', 300),
            'default_model': getattr(config_module, 'DEFAULT_MODEL', 'llama3'),
            'default_workspace': getattr(config_module, 'DEFAULT_WORKSPACE', None),
        }
        
        # Validate required configuration
        required_keys = ['api_url', 'api_key', 'tasks_directory', 'pending_directory', 'completed_directory', 'failed_directory', 'request_timeout', 'default_model', 'default_workspace']
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

def parse_frontmatter(filepath):
    """
    Parses a markdown file with frontmatter.
    Returns a tuple (metadata, content).
    """
    with open(filepath, 'r') as f:
        content = f.read()
    
    # Check if file has frontmatter (starts with ---)
    if not content.startswith('---'):
        # No frontmatter, return empty metadata and full content
        return {}, content
    
    # Find the end of frontmatter (second ---)
    parts = content.split('---', 2)
    
    if len(parts) < 3:
        # Invalid frontmatter format, return empty metadata
        return {}, content
    
    frontmatter_text = parts[1].strip()
    body = parts[2].strip()
    
    # Parse simple frontmatter
    metadata = {}
    try:
        for line in frontmatter_text.split('\n'):
            line = line.strip()
            if ':' in line:
                key, value = line.split(':', 1)
                key = key.strip().lower()
                value = value.strip()
                # Remove quotes from values
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                elif value.startswith("'") and value.endswith("'"):
                    value = value[1:-1]
                
                # Try to parse as boolean or number
                if value.lower() == 'true':
                    value = True
                elif value.lower() == 'false':
                    value = False
                elif value.isdigit():
                    value = int(value)
                
                metadata[key] = value
    except Exception as e:
        print(f"Warning: Could not parse frontmatter in {os.path.basename(filepath)}")
    
    return metadata, body

def write_frontmatter(filepath, metadata, content, response=None):
    """
    Writes a markdown file with frontmatter.
    Optionally appends a response section at bottom.
    """
    # Convert metadata to frontmatter format
    frontmatter_lines = []
    for key, value in metadata.items():
        if isinstance(value, str):
            frontmatter_lines.append(f'{key}: "{value}"')
        else:
            frontmatter_lines.append(f'{key}: {value}')
    
    frontmatter_text = '\n'.join(frontmatter_lines)
    
    # Construct the file content
    full_content = f"---\n{frontmatter_text}\n---\n\n{content}"
    
    # Append response if provided
    if response:
        full_content += f"\n\n---\n\n## Response\n\n{response}\n"
    
    with open(filepath, 'w') as f:
        f.write(full_content)

def check_completion_criteria(response_text, criteria):
    """
    Evaluates the LLM response against the criteria defined in the markdown file.
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

def submit_to_openwebui(model, content, workspace_id=None):
    """
    Sends the prompt to the OpenWebUI API.
    Returns tuple: (content, log_data)
    - content: The response message content (or None on error)
    - log_data: Dictionary with detailed logging information (or None on success)
    """
    import json
    
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
    import json
    
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

def strip_acceptance_criteria(content):
    """
    Removes the Acceptance Criteria section from the content.
    Returns the content without the acceptance criteria section.
    """
    lines = content.split('\n')
    result_lines = []
    skip_section = False
    
    for line in lines:
        # Check if this is the start of Acceptance Criteria section
        if line.strip() == '## Acceptance Criteria':
            skip_section = True
            continue
        
        # If we're skipping, continue until we hit another heading
        if skip_section:
            if line.startswith('## ') and not line.strip() == '## Acceptance Criteria':
                skip_section = False
                result_lines.append(line)
            continue
        
        result_lines.append(line)
    
    return '\n'.join(result_lines)

def parse_evaluator_response(evaluator_response):
    """
    Parses the evaluator's response to extract JSON data.
    Returns tuple: (json_data, error_message)
    """
    import json
    
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

def create_subtask(original_task_name, evaluator_response, original_metadata):
    """
    Creates a new subtask file with the evaluator's response.
    Returns the filepath of the created subtask.
    """
    cfg = get_config()
    pending_directory = cfg['pending_directory']
    
    # Remove 6-digit hash from original task name if present
    import re
    cleaned_task_name = re.sub(r'_[a-f0-9]{6}$', '', original_task_name)
    
    # Generate subtask filename (without _eval suffix)
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    subtask_name = f"{cleaned_task_name}_{timestamp}.md"
    subtask_path = os.path.join(pending_directory, subtask_name)
    
    # Create metadata for subtask
    subtask_metadata = {
        'status': 'pending',
        'model': original_metadata.get('model', cfg.get('default_model', 'llama3')),
        'workspace': 'evaluator',
        'original_task': original_task_name,
        'created_at': time.strftime("%Y-%m-%d %H:%M:%S"),
        'task_type': 'evaluation'
    }
    
    # Write the subtask with evaluator response as content
    write_frontmatter(subtask_path, subtask_metadata, evaluator_response)
    
    print(f"Created evaluation subtask: {subtask_name}")
    return subtask_path

def create_next_steps_subtasks(original_task_name, next_steps, original_metadata):
    """
    Creates subtasks for each item in the next_steps array.
    Returns list of created filepaths.
    """
    cfg = get_config()
    pending_directory = cfg['pending_directory']
    created_files = []
    
    # Remove 6-digit hash from original task name if present
    import re
    cleaned_task_name = re.sub(r'_[a-f0-9]{6}$', '', original_task_name)
    
    for i, step in enumerate(next_steps):
        timestamp = time.strftime("%Y%m%d_%H%M%S")
        subtask_name = f"{cleaned_task_name}_step{i+1}_{timestamp}.md"
        subtask_path = os.path.join(pending_directory, subtask_name)
        
        # Create metadata for subtask
        subtask_metadata = {
            'status': 'pending',
            'model': original_metadata.get('model', cfg.get('default_model', 'llama3')),
            'workspace': original_metadata.get('workspace', cfg.get('default_workspace', None)),
            'original_task': original_task_name,
            'created_at': time.strftime("%Y-%m-%d %H:%M:%S"),
            'task_type': 'next_step',
            'step_number': i + 1
        }
        
        # Write the subtask with the step content
        write_frontmatter(subtask_path, subtask_metadata, str(step))
        
        print(f"Created next step subtask: {subtask_name}")
        created_files.append(subtask_path)
    
    return created_files

def process_markdown_file(filepath):
    """
    Reads a task file, executes it if pending, and updates status.
    Moves completed tasks to the completed directory.
    Moves failed tasks to the failed directory.
    After successful completion, sends response to evaluator workspace and creates subtask.
    """
    print(f"--- Processing {os.path.basename(filepath)} ---")
    
    # 1. Load the file content and frontmatter
    try:
        metadata, content = parse_frontmatter(filepath)
    except Exception as e:
        print(f"Error reading file {filepath}: {e}")
        return

    # 2. Check Status
    current_status = metadata.get('status', 'pending')
    
    if current_status == 'complete':
        print("Task already marked as complete. Moving to completed folder...")
        move_to_completed(filepath, metadata, content)
        return
    
    if current_status == 'failed':
        print("Task already marked as failed. Moving to failed folder...")
        move_to_failed(filepath, metadata, content)
        return
    
    if current_status == 'running':
        print("Skipping: Task currently marked as running (might be handled by another process).")
        return

    # 3. Strip acceptance criteria from content before sending to OpenWebUI
    content_to_send = strip_acceptance_criteria(content)
    if content_to_send != content:
        print("Acceptance criteria section removed from request")
    
    # 4. Extract Metadata (with fallback to config defaults)
    cfg = get_config()
    model = metadata.get('model', cfg.get('default_model', 'llama3'))
    workspace = metadata.get('workspace', cfg.get('default_workspace', None))
    criteria = metadata.get('completion_criteria')
    
    # 4. Update Status to 'running' immediately to prevent double execution
    metadata['status'] = 'running'
    metadata['last_updated'] = time.strftime("%Y-%m-%d %H:%M:%S")
    
    try:
        write_frontmatter(filepath, metadata, content)
    except Exception as e:
        print(f"Error writing running status: {e}")
        return

    # 5. Execute Task (without acceptance criteria)
    print(f"Submitting to model '{model}' in workspace '{workspace}'...")
    llm_response, log_data = submit_to_openwebui(model, content_to_send, workspace)

    # 6. Evaluate Results
    if llm_response:
        print("Response received. Checking criteria...")
        is_complete = check_completion_criteria(llm_response, criteria)
        
        if is_complete:
            print("Criteria met. Marking as COMPLETE.")
            metadata['status'] = 'complete'
            # Optional: Store the response in the metadata or append to file
            # metadata['response_summary'] = llm_response[:200] + "..." 
        else:
            print("Criteria NOT met. Marking as INCOMPLETE.")
            metadata['status'] = 'incomplete'
            metadata['failure_reason'] = 'Completion criteria not met'
    else:
        print("No response received from API. Marking as FAILED.")
        metadata['status'] = 'failed'
        metadata['failure_reason'] = 'API Request Failed'

    # 7. Final Write
    metadata['last_updated'] = time.strftime("%Y-%m-%d %H:%M:%S")
    
    # Store the response in the file
    response_to_write = None
    if llm_response:
        response_to_write = llm_response
    else:
        # On failure, store the error log as formatted text
        import json
        response_to_write = format_error_log(log_data)
    
    write_frontmatter(filepath, metadata, content, response_to_write)
    
    # 8. Move to appropriate folder based on status
    if metadata.get('status') == 'complete':
        # Before moving, send response to evaluator workspace and create subtask
        print("Sending response to evaluator workspace...")
        original_task_name = os.path.splitext(os.path.basename(filepath))[0]
        evaluator_response, evaluator_log = submit_to_openwebui(model, llm_response, 'evaluator')
        
        if evaluator_response:
            print("Evaluator response received. Parsing response...")
            
            # Parse evaluator response to look for JSON with acceptance_status
            json_data, parse_error = parse_evaluator_response(evaluator_response)
            
            if json_data:
                print("Successfully parsed evaluator response JSON")
                
                # Check for acceptance_status
                acceptance_status = json_data.get('acceptance_status', '').lower()
                print(f"Acceptance status: {acceptance_status}")
                
                if acceptance_status == 'no':
                    # Look for NEXT STEPS array
                    next_steps = json_data.get('NEXT STEPS', json_data.get('next_steps', json_data.get('next_steps', [])))
                    
                    if next_steps and isinstance(next_steps, list) and len(next_steps) > 0:
                        print(f"Found {len(next_steps)} next steps. Creating subtasks...")
                        create_next_steps_subtasks(original_task_name, next_steps, metadata)
                    else:
                        print("No next steps found in evaluator response")
                
                # Always create the evaluation subtask with full response
                create_subtask(original_task_name, evaluator_response, metadata)
            else:
                print(f"Could not parse evaluator response as JSON: {parse_error}")
                # Still create subtask with raw response
                create_subtask(original_task_name, evaluator_response, metadata)
        else:
            print(f"Warning: Failed to get evaluator response: {evaluator_log.get('error_message', 'Unknown error') if evaluator_log else 'No log available'}")
        
        move_to_completed(filepath, metadata, content, response_to_write)
    elif metadata.get('status') == 'failed':
        move_to_failed(filepath, metadata, content, response_to_write)

def move_to_completed(filepath, metadata, content, response=None):
    """
    Moves a completed task file to the completed directory.
    Adds task ID to metadata and filename.
    """
    cfg = get_config()
    if cfg is None:
        print("Error: Configuration not loaded. Cannot move file.")
        return
    
    completed_directory = cfg['completed_directory']
    
    # Ensure the completed directory exists
    if not os.path.exists(completed_directory):
        try:
            os.makedirs(completed_directory)
            print(f"Created directory: {completed_directory}")
        except Exception as e:
            print(f"Error creating completed directory: {e}")
            return
    
    # Add created_at timestamp and task ID to metadata
    created_at = time.strftime("%Y-%m-%d %H:%M:%S")
    full_hash, short_hash = generate_task_id(created_at)
    
    metadata['created_at'] = created_at
    metadata['task_id'] = full_hash
    
    # Rewrite the file with updated metadata, preserving response
    write_frontmatter(filepath, metadata, content, response)
    
    # Generate new filename with short hash
    filename = os.path.basename(filepath)
    name_without_ext = os.path.splitext(filename)[0]
    new_filename = f"{name_without_ext}_{short_hash}.md"
    destination = os.path.join(completed_directory, new_filename)
    
    try:
        # Move the file with new name
        os.rename(filepath, destination)
        print(f"Moved '{filename}' to completed folder as '{new_filename}'.")
    except Exception as e:
        print(f"Error moving file to completed folder: {e}")

def move_to_failed(filepath, metadata, content, response=None):
    """
    Moves a failed task file to the failed directory.
    Adds task ID to metadata and filename.
    """
    cfg = get_config()
    if cfg is None:
        print("Error: Configuration not loaded. Cannot move file.")
        return
    
    failed_directory = cfg['failed_directory']
    
    # Ensure the failed directory exists
    if not os.path.exists(failed_directory):
        try:
            os.makedirs(failed_directory)
            print(f"Created directory: {failed_directory}")
        except Exception as e:
            print(f"Error creating failed directory: {e}")
            return
    
    # Add created_at timestamp and task ID to metadata
    created_at = time.strftime("%Y-%m-%d %H:%M:%S")
    full_hash, short_hash = generate_task_id(created_at)
    
    metadata['created_at'] = created_at
    metadata['task_id'] = full_hash
    
    # Rewrite the file with updated metadata, preserving response
    write_frontmatter(filepath, metadata, content, response)
    
    # Generate new filename with short hash
    filename = os.path.basename(filepath)
    name_without_ext = os.path.splitext(filename)[0]
    new_filename = f"{name_without_ext}_{short_hash}.md"
    destination = os.path.join(failed_directory, new_filename)
    
    try:
        # Move the file with new name
        os.rename(filepath, destination)
        print(f"Moved '{filename}' to failed folder as '{new_filename}'.")
    except Exception as e:
        print(f"Error moving file to failed folder: {e}")

def main():
    # Load configuration
    cfg = get_config()
    if cfg is None:
        print("Error: Failed to load configuration. Please create config.py from config.example.py")
        return
    
    pending_directory = cfg['pending_directory']
    completed_directory = cfg['completed_directory']
    failed_directory = cfg['failed_directory']
    
    if not os.path.exists(pending_directory):
        print(f"Directory '{pending_directory}' not found.")
        return

    # Ensure the completed directory exists
    if not os.path.exists(completed_directory):
        try:
            os.makedirs(completed_directory)
            print(f"Created directory: {completed_directory}")
        except Exception as e:
            print(f"Error creating completed directory: {e}")
            return
    
    # Ensure the failed directory exists
    if not os.path.exists(failed_directory):
        try:
            os.makedirs(failed_directory)
            print(f"Created directory: {failed_directory}")
        except Exception as e:
            print(f"Error creating failed directory: {e}")
            return

    # Get all .md files in the pending directory
    md_files = [filename for filename in os.listdir(pending_directory) if filename.endswith(".md")]
    
    # Check if there are any pending tasks
    if not md_files:
        print("No pending tasks found in the pending directory.")
        return

    # Iterate over all .md files in the pending directory
    for filename in md_files:
        filepath = os.path.join(pending_directory, filename)
        process_markdown_file(filepath)

if __name__ == "__main__":
    main()
