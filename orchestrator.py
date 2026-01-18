import os
import time
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
    Parses a markdown file with YAML-like frontmatter.
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
    
    # Parse simple YAML-like frontmatter
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
    Writes a markdown file with YAML-like frontmatter.
    Optionally appends a response section at bottom.
    """
    # Convert metadata to YAML-like format
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
    """
    cfg = get_config()
    if cfg is None:
        print("Error: Configuration not loaded. Cannot submit to API.")
        return None
    
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
        "stream": False # We wait for the full response for this basic orchestrator
    }

    # Optional: Some OpenWebUI setups pass workspace in headers or query params
    # This is a placeholder for advanced routing if your specific setup needs it.
    if workspace_id:
        headers["X-Workspace-ID"] = workspace_id

    try:
        response = requests.post(cfg['api_url'], headers=headers, json=payload, timeout=cfg['request_timeout'])
        response.raise_for_status()
        data = response.json()
        
        # Extract content from standard OpenAI format response
        return data['choices'][0]['message']['content']
    except RequestException as e:
        print(f"API Error: {e}")
        return None
    except (KeyError, IndexError) as e:
        print(f"Response Parsing Error: {e} - Response: {response.text}")
        return None

def process_markdown_file(filepath):
    """
    Reads a task file, executes it if pending, and updates status.
    Moves completed tasks to the completed directory.
    Moves failed tasks to the failed directory.
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
        move_to_completed(filepath)
        return
    
    if current_status == 'failed':
        print("Task already marked as failed. Moving to failed folder...")
        move_to_failed(filepath)
        return
    
    if current_status == 'running':
        print("Skipping: Task currently marked as running (might be handled by another process).")
        return

    # 3. Extract Metadata (with fallback to config defaults)
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

    # 5. Execute Task
    print(f"Submitting to model '{model}' in workspace '{workspace}'...")
    llm_response = submit_to_openwebui(model, content, workspace)

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
    if llm_response:
        write_frontmatter(filepath, metadata, content, llm_response)
    else:
        write_frontmatter(filepath, metadata, content)
    
    # 8. Move to appropriate folder based on status
    if metadata.get('status') == 'complete':
        move_to_completed(filepath)
    elif metadata.get('status') == 'failed':
        move_to_failed(filepath)

def move_to_completed(filepath):
    """
    Moves a completed task file to the completed directory.
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
    
    filename = os.path.basename(filepath)
    destination = os.path.join(completed_directory, filename)
    
    try:
        # Move the file
        os.rename(filepath, destination)
        print(f"Moved '{filename}' to completed folder.")
    except Exception as e:
        print(f"Error moving file to completed folder: {e}")

def move_to_failed(filepath):
    """
    Moves a failed task file to the failed directory.
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
    
    filename = os.path.basename(filepath)
    destination = os.path.join(failed_directory, filename)
    
    try:
        # Move the file
        os.rename(filepath, destination)
        print(f"Moved '{filename}' to failed folder.")
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
