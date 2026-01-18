import os
import time
import requests
import yaml
from requests.exceptions import RequestException

# --- CONFIGURATION ---
# Default API URL for local OpenWebUI (OpenAI compatible endpoint)
# Adjust port if your instance runs on a different port (default is 3000)
API_URL = "http://192.168.2.245:8080/api/v1/chat/completions"
API_KEY = ""  # Leave empty if local auth is disabled, otherwise add your Bearer token

# Directory containing your task markdown files
TASKS_DIRECTORY = "./tasks"
COMPLETED_DIRECTORY = os.path.join(TASKS_DIRECTORY, "completed")

# How long to wait (seconds) for a long-running API response before timing out
REQUEST_TIMEOUT = 300 

def parse_frontmatter(filepath):
    """
    Parses a markdown file with YAML frontmatter.
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
    
    # Parse YAML frontmatter
    try:
        metadata = yaml.safe_load(frontmatter_text) or {}
    except yaml.YAMLError:
        # If YAML parsing fails, return empty metadata
        print(f"Warning: Could not parse frontmatter in {os.path.basename(filepath)}")
        metadata = {}
    
    return metadata, body

def write_frontmatter(filepath, metadata, content):
    """
    Writes a markdown file with YAML frontmatter.
    """
    # Convert metadata to YAML
    frontmatter_text = yaml.dump(metadata, default_flow_style=False, sort_keys=False)
    
    # Construct the file content
    full_content = f"---\n{frontmatter_text}---\n\n{content}"
    
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
    headers = {
        "Content-Type": "application/json"
    }
    
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"

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
        response = requests.post(API_URL, headers=headers, json=payload, timeout=REQUEST_TIMEOUT)
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
    Moves completed tasks to the ./completed directory.
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
    
    if current_status == 'running':
        print("Skipping: Task currently marked as running (might be handled by another process).")
        return

    # 3. Extract Metadata
    model = metadata.get('model', 'llama3') # Default model if not specified
    workspace = metadata.get('workspace')
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
            print("Criteria NOT met. Marking as FAILED/INCOMPLETE.")
            metadata['status'] = 'incomplete'
            metadata['failure_reason'] = 'Completion criteria not met'
    else:
        print("No response received from API. Marking as FAILED.")
        metadata['status'] = 'failed'
        metadata['failure_reason'] = 'API Request Failed'

    # 7. Final Write
    metadata['last_updated'] = time.strftime("%Y-%m-%d %H:%M:%S")
    write_frontmatter(filepath, metadata, content)
    
    # 8. Move to completed folder if task is complete
    if metadata.get('status') == 'complete':
        move_to_completed(filepath)

def move_to_completed(filepath):
    """
    Moves a completed task file to the ./completed directory.
    """
    # Ensure the completed directory exists
    if not os.path.exists(COMPLETED_DIRECTORY):
        try:
            os.makedirs(COMPLETED_DIRECTORY)
            print(f"Created directory: {COMPLETED_DIRECTORY}")
        except Exception as e:
            print(f"Error creating completed directory: {e}")
            return
    
    filename = os.path.basename(filepath)
    destination = os.path.join(COMPLETED_DIRECTORY, filename)
    
    try:
        # Move the file
        os.rename(filepath, destination)
        print(f"Moved '{filename}' to completed folder.")
    except Exception as e:
        print(f"Error moving file to completed folder: {e}")

def main():
    if not os.path.exists(TASKS_DIRECTORY):
        print(f"Directory '{TASKS_DIRECTORY}' not found.")
        return

    # Ensure the completed directory exists
    if not os.path.exists(COMPLETED_DIRECTORY):
        try:
            os.makedirs(COMPLETED_DIRECTORY)
            print(f"Created directory: {COMPLETED_DIRECTORY}")
        except Exception as e:
            print(f"Error creating completed directory: {e}")
            return

    # Iterate over all .md files in the directory
    for filename in os.listdir(TASKS_DIRECTORY):
        if filename.endswith(".md"):
            filepath = os.path.join(TASKS_DIRECTORY, filename)
            process_markdown_file(filepath)

if __name__ == "__main__":
    main()
