from flask import Flask, render_template, request, redirect, url_for, flash
import os
import glob
from datetime import datetime
import importlib.util
import threading
import time
import subprocess

app = Flask(__name__)
app.secret_key = 'your-secret-key-change-this'

# Global state for orchestrator
orchestrator_running = False
orchestrator_thread = None

# Load configuration from config.py
def load_config():
    config_path = "config.py"
    if not os.path.exists(config_path):
        return {
            'pending_directory': './tasks/pending',
            'completed_directory': './tasks/completed',
            'failed_directory': './tasks/failed',
            'default_model': 'llama3',
            'default_workspace': 'default'
        }
    
    spec = importlib.util.spec_from_file_location("config", config_path)
    config_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config_module)
    
    return {
        'pending_directory': getattr(config_module, 'PENDING_DIRECTORY', './tasks/pending'),
        'completed_directory': getattr(config_module, 'COMPLETED_DIRECTORY', './tasks/completed'),
        'failed_directory': getattr(config_module, 'FAILED_DIRECTORY', './tasks/failed'),
        'default_model': getattr(config_module, 'DEFAULT_MODEL', 'llama3'),
        'default_workspace': getattr(config_module, 'DEFAULT_WORKSPACE', 'default'),
    }

config = load_config()

def run_orchestrator():
    """Background thread to run orchestrator every 5 minutes"""
    global orchestrator_running
    while orchestrator_running:
        try:
            subprocess.run(['python3', 'orchestrator.py'], check=True, capture_output=True)
        except subprocess.CalledProcessError as e:
            print(f"Orchestrator error: {e}")
        except Exception as e:
            print(f"Unexpected error: {e}")
        
        # Wait 5 minutes before next run (300 seconds)
        for _ in range(300):
            if not orchestrator_running:
                break
            time.sleep(1)

@app.route('/orchestrator/start')
def start_orchestrator():
    """Start the orchestrator background thread"""
    global orchestrator_running, orchestrator_thread
    
    if orchestrator_running:
        flash('Orchestrator is already running!', 'error')
        return redirect(url_for('index'))
    
    orchestrator_running = True
    orchestrator_thread = threading.Thread(target=run_orchestrator, daemon=True)
    orchestrator_thread.start()
    flash('Orchestrator started! Will run every 5 minutes.', 'success')
    return redirect(url_for('index'))

@app.route('/orchestrator/stop')
def stop_orchestrator():
    """Stop the orchestrator background thread"""
    global orchestrator_running
    
    if not orchestrator_running:
        flash('Orchestrator is not running!', 'error')
        return redirect(url_for('index'))
    
    orchestrator_running = False
    flash('Orchestrator stopped!', 'success')
    return redirect(url_for('index'))

def parse_frontmatter(filepath):
    """Parse markdown file with frontmatter and separate response if present"""
    with open(filepath, 'r') as f:
        content = f.read()
    
    if not content.startswith('---'):
        return {}, content
    
    parts = content.split('---', 2)
    
    if len(parts) < 3:
        return {}, content
    
    frontmatter_text = parts[1].strip()
    body = parts[2]
    
    metadata = {}
    for line in frontmatter_text.split('\n'):
        line = line.strip()
        if ':' in line:
            key, value = line.split(':', 1)
            key = key.strip().lower()
            value = value.strip()
            
            if value.startswith('"') and value.endswith('"'):
                value = value[1:-1]
            elif value.startswith("'") and value.endswith("'"):
                value = value[1:-1]
            
            metadata[key] = value
    
    return metadata, body

def write_frontmatter(filepath, metadata, content, response=None):
    """Writes a markdown file with frontmatter"""
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

def get_tasks_from_directory(directory):
    """Get all tasks from a directory"""
    tasks = []
    if not os.path.exists(directory):
        return tasks
    
    for filepath in glob.glob(os.path.join(directory, '*.md')):
        filename = os.path.basename(filepath)
        metadata, content = parse_frontmatter(filepath)
        
        # Get file modification time
        mod_time = datetime.fromtimestamp(os.path.getmtime(filepath))
        
        task = {
            'filename': filename,
            'filepath': filepath,
            'metadata': metadata,
            'content': content[:200] + '...' if len(content) > 200 else content,
            'full_content': content,
            'modified': mod_time,
            'status': metadata.get('status', 'pending'),
            'model': metadata.get('model', config['default_model']),
            'workspace': metadata.get('workspace', config['default_workspace'])
        }
        tasks.append(task)
    
    # Sort by modification time (newest first)
    tasks.sort(key=lambda x: x['modified'], reverse=True)
    return tasks

@app.route('/')
def index():
    """Main dashboard"""
    pending_tasks = get_tasks_from_directory(config['pending_directory'])
    completed_tasks = get_tasks_from_directory(config['completed_directory'])
    failed_tasks = get_tasks_from_directory(config['failed_directory'])
    
    # Calculate statistics
    stats = {
        'total': len(pending_tasks) + len(completed_tasks) + len(failed_tasks),
        'pending': len(pending_tasks),
        'completed': len(completed_tasks),
        'failed': len(failed_tasks),
        'success_rate': round((len(completed_tasks) / (len(completed_tasks) + len(failed_tasks)) * 100), 1) 
                       if (len(completed_tasks) + len(failed_tasks)) > 0 else 0
    }
    
    return render_template('index.html', 
                          stats=stats,
                          pending_tasks=pending_tasks,
                          completed_tasks=completed_tasks,
                          failed_tasks=failed_tasks,
                          orchestrator_running=orchestrator_running)

@app.route('/task/<category>/<filename>')
def view_task(category, filename):
    """View a specific task"""
    if category == 'pending':
        directory = config['pending_directory']
    elif category == 'completed':
        directory = config['completed_directory']
    elif category == 'failed':
        directory = config['failed_directory']
    else:
        flash('Invalid category', 'error')
        return redirect(url_for('index'))
    
    filepath = os.path.join(directory, filename)
    if not os.path.exists(filepath):
        flash('Task not found', 'error')
        return redirect(url_for('index'))
    
    metadata, body = parse_frontmatter(filepath)
    mod_time = datetime.fromtimestamp(os.path.getmtime(filepath))
    
    # Separate response from content if it exists
    response = None
    content = body
    
    # Check if there's a response section separated by ---
    if '\n---\n' in body and '## Response' in body:
        # Split on the third --- which separates task content from response
        # We look for the separator that comes before the Response heading
        body_parts = body.split('\n---\n', 1)
        if len(body_parts) > 1:
            # First part is the task content
            content = body_parts[0].strip()
            # Second part contains the response section
            response_part = body_parts[1]
            # Find the Response heading and get everything after it
            response_idx = response_part.find('## Response')
            if response_idx != -1:
                # Get everything after the Response heading
                response = response_part[response_idx + len('## Response'):].strip()
    
    task = {
        'filename': filename,
        'category': category,
        'metadata': metadata,
        'content': content,
        'response': response,
        'modified': mod_time
    }
    
    return render_template('view_task.html', task=task)

@app.route('/create', methods=['GET', 'POST'])
def create_task():
    """Create a new task"""
    if request.method == 'POST':
        filename = request.form.get('filename', '').strip()
        if not filename.endswith('.md'):
            filename += '.md'
        
        model = request.form.get('model', config['default_model'])
        workspace = request.form.get('workspace', config['default_workspace'])
        content = request.form.get('content', '').strip()
        
        # Create frontmatter
        frontmatter = f"""---
model: "{model}"
workspace: "{workspace}"
status: "pending"
---

{content}"""
        
        # Ensure directory exists
        if not os.path.exists(config['pending_directory']):
            os.makedirs(config['pending_directory'])
        
        # Write task file
        filepath = os.path.join(config['pending_directory'], filename)
        try:
            with open(filepath, 'w') as f:
                f.write(frontmatter)
            flash(f'Task "{filename}" created successfully!', 'success')
            return redirect(url_for('index'))
        except Exception as e:
            flash(f'Error creating task: {str(e)}', 'error')
    
    return render_template('create_task.html', 
                          default_model=config['default_model'],
                          default_workspace=config['default_workspace'])

@app.route('/retry/<filename>')
def retry_task(filename):
    """Retry a failed task by copying it to pending directory"""
    failed_directory = config['failed_directory']
    pending_directory = config['pending_directory']
    
    # Ensure pending directory exists
    if not os.path.exists(pending_directory):
        os.makedirs(pending_directory)
    
    source_path = os.path.join(failed_directory, filename)
    
    if not os.path.exists(source_path):
        flash('Task not found in failed directory', 'error')
        return redirect(url_for('index'))
    
    # Read the failed task
    metadata, content = parse_frontmatter(source_path)
    
    # Update status to pending
    metadata['status'] = 'pending'
    
    # Remove any failure reason from metadata
    if 'failure_reason' in metadata:
        del metadata['failure_reason']
    
    # Create new filename with retry timestamp
    base_name = filename.replace('.md', '')
    timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    new_filename = f"{base_name}_retry_{timestamp}.md"
    
    # Write to pending directory
    destination_path = os.path.join(pending_directory, new_filename)
    
    try:
        write_frontmatter(destination_path, metadata, content)
        flash(f'Task "{filename}" has been retried as "{new_filename}" and moved to pending!', 'success')
    except Exception as e:
        flash(f'Error retrying task: {str(e)}', 'error')
    
    return redirect(url_for('index'))

@app.route('/delete/<category>/<filename>')
def delete_task(category, filename):
    """Delete a task"""
    if category == 'pending':
        directory = config['pending_directory']
    elif category == 'completed':
        directory = config['completed_directory']
    elif category == 'failed':
        directory = config['failed_directory']
    else:
        flash('Invalid category', 'error')
        return redirect(url_for('index'))
    
    filepath = os.path.join(directory, filename)
    if os.path.exists(filepath):
        try:
            os.remove(filepath)
            flash(f'Task "{filename}" deleted successfully!', 'success')
        except Exception as e:
            flash(f'Error deleting task: {str(e)}', 'error')
    else:
        flash('Task not found', 'error')
    
    return redirect(url_for('index'))

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
