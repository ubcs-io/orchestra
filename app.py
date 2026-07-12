from flask import Flask, render_template, request, redirect, url_for, flash
import os
from datetime import datetime
import importlib.util
import threading
import time
import subprocess
import requests

import db

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
            'db_path': './orchestra.db',
            'default_model': 'llama3',
            'default_workspace': 'default'
        }

    spec = importlib.util.spec_from_file_location("config", config_path)
    config_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(config_module)

    return {
        'db_path': getattr(config_module, 'DB_PATH', './orchestra.db'),
        'default_model': getattr(config_module, 'DEFAULT_MODEL', 'llama3'),
        'default_workspace': getattr(config_module, 'DEFAULT_WORKSPACE', 'default'),
    }

config = load_config()
db.init_db()

def fetch_available_models():
    """Fetch available models from OpenWebUI /api/models endpoint"""
    # Create logs directory if it doesn't exist
    logs_dir = "logs"
    if not os.path.exists(logs_dir):
        os.makedirs(logs_dir)
    
    log_file = os.path.join(logs_dir, "model_fetch_errors.log")
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    
    def write_log(message):
        """Helper to write to log file immediately"""
        with open(log_file, 'a') as f:
            f.write(message)
    
    try:
        # Load config to get API URL and key
        config_path = "config.py"
        if not os.path.exists(config_path):
            write_log(f"[{timestamp}] Error: config.py not found\n\n")
            return []
        
        spec = importlib.util.spec_from_file_location("config", config_path)
        config_module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(config_module)
        
        api_url = getattr(config_module, 'API_URL', None)
        api_key = getattr(config_module, 'API_KEY', '')
        
        if not api_url:
            write_log(f"[{timestamp}] Error: API_URL not configured in config.py\n\n")
            return []
        
        # Construct models endpoint URL
        # API_URL might be full endpoint path (e.g., http://host/api/v1/chat/completions)
        # We need to extract base URL and add /models or /api/models
        from urllib.parse import urlparse
        
        parsed = urlparse(api_url)
        base_url = f"{parsed.scheme}://{parsed.netloc}"
        
        # Prepare headers
        headers = {
            "Content-Type": "application/json"
        }
        
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        
        # Try different possible model endpoint paths
        possible_endpoints = [
            "/api/models",
            "/api/v1/models", 
            "/v1/models",
            "/models"
        ]
        
        models_url = None
        response = None
        for endpoint in possible_endpoints:
            models_url = f"{base_url}{endpoint}"
            write_log(f"Trying endpoint: {models_url}\n")
            try:
                response = requests.get(models_url, headers=headers, timeout=10)
                write_log(f"Status Code: {response.status_code}\n")
                
                if response.status_code == 200:
                    write_log(f"Success! Got response from {models_url}\n")
                    break
                else:
                    write_log(f"Failed (status {response.status_code}), trying next endpoint...\n")
                    continue
            except Exception as e:
                write_log(f"Failed: {e}, trying next endpoint...\n")
                continue
        else:
            # All endpoints failed
            write_log(f"All endpoints failed, using last tried: {models_url}\n")
        
        # Log request details immediately
        write_log(f"[{timestamp}] Fetching models from: {models_url}\n")
        
        # Log response details immediately (response is already fetched above)
        write_log(f"Response Headers: {dict(response.headers)}\n")
        write_log(f"Response Text: {response.text}\n")
        
        try:
            response.raise_for_status()
        except Exception as http_error:
            write_log(f"HTTP Error: {type(http_error).__name__}: {http_error}\n\n")
            raise http_error
        
        # Try to parse JSON
        try:
            data = response.json()
            write_log(f"Parsed JSON: {data}\n")
        except Exception as json_error:
            write_log(f"JSON Parse Error: {type(json_error).__name__}: {json_error}\n\n")
            raise json_error
        
        # Extract model names from response
        # OpenWebUI typically returns {"data": [{"id": "model-name", ...}]}
        models = []
        if isinstance(data, dict) and 'data' in data:
            for model_data in data['data']:
                if isinstance(model_data, dict) and 'id' in model_data:
                    models.append(model_data['id'])
        elif isinstance(data, list):
            # Handle case where response is directly a list
            for model_data in data:
                if isinstance(model_data, dict) and 'id' in model_data:
                    models.append(model_data['id'])
        
        write_log(f"Found {len(models)} models: {models}\n\n")
        
        return models
    except Exception as e:
        write_log(f"[{timestamp}] Error fetching models: {type(e).__name__}: {e}\n\n")
        print(f"Error fetching models: {e}")
        return []

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
    """Start orchestrator background thread"""
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
    """Stop orchestrator background thread"""
    global orchestrator_running
    
    if not orchestrator_running:
        flash('Orchestrator is not running!', 'error')
        return redirect(url_for('index'))
    
    orchestrator_running = False
    flash('Orchestrator stopped!', 'success')
    return redirect(url_for('index'))

def enrich_task(task):
    """Add derived display fields to a task row dict."""
    if task is None:
        return None
    task['content_preview'] = (
        (task.get('content') or '')[:200] + '...'
        if len(task.get('content') or '') > 200
        else (task.get('content') or '')
    )
    task['model'] = task.get('model') or config['default_model']
    task['workspace'] = task.get('workspace') or config['default_workspace']
    task['category'] = status_to_category(task.get('status'))

    # Parse a timestamp for display; fall back to now if missing/malformed.
    ts = task.get('updated_at') or task.get('created_at')
    try:
        task['modified'] = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        task['modified'] = datetime.now()
    return task

def status_to_category(status):
    """Map a task status to one of the dashboard buckets."""
    if status == 'complete':
        return 'completed'
    if status == 'failed':
        return 'failed'
    return 'pending'

@app.route('/')
def index():
    """Main dashboard"""
    pending_tasks = [enrich_task(t) for t in db.list_tasks(status=['pending', 'running', 'incomplete'])]
    completed_tasks = [enrich_task(t) for t in db.list_tasks(status='complete')]
    failed_tasks = [enrich_task(t) for t in db.list_tasks(status='failed')]

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

@app.route('/task/<int:task_id>')
def view_task(task_id):
    """View a specific task"""
    task = db.get_task(task_id)
    if task is None:
        flash('Task not found', 'error')
        return redirect(url_for('index'))

    task = enrich_task(task)
    return render_template('view_task.html', task=task)

@app.route('/create', methods=['GET', 'POST'])
def create_task():
    """Create a new task"""
    # Fetch available models
    available_models = fetch_available_models()

    # If no models found, use default
    if not available_models:
        available_models = [config['default_model']]

    if request.method == 'POST':
        name = request.form.get('filename', '').strip()
        if name.endswith('.md'):
            name = name[:-3]

        model = request.form.get('model', config['default_model'])
        workspace = request.form.get('workspace', config['default_workspace'])
        content = request.form.get('content', '').strip()
        acceptance_criteria = request.form.get('acceptance_criteria', '').strip() or None

        try:
            db.create_task(
                name=name,
                content=content,
                status='pending',
                model=model,
                workspace=workspace,
                acceptance_criteria=acceptance_criteria,
                task_type='root',
            )
            flash(f'Task "{name}" created successfully!', 'success')
            return redirect(url_for('index'))
        except Exception as e:
            flash(f'Error creating task: {str(e)}', 'error')

    return render_template('create_task.html',
                          default_model=config['default_model'],
                          default_workspace=config['default_workspace'],
                          available_models=available_models)

@app.route('/retry/<int:task_id>')
def retry_task(task_id):
    """Retry a failed task by resetting it to pending"""
    task = db.get_task(task_id)
    if task is None:
        flash('Task not found', 'error')
        return redirect(url_for('index'))

    try:
        db.update_task(task_id, status='pending', response=None, failure_reason=None)
        flash(f'Task "{task["name"]}" has been reset to pending!', 'success')
    except Exception as e:
        flash(f'Error retrying task: {str(e)}', 'error')

    return redirect(url_for('index'))

@app.route('/delete/<int:task_id>')
def delete_task(task_id):
    """Delete a task"""
    task = db.get_task(task_id)
    if task is None:
        flash('Task not found', 'error')
        return redirect(url_for('index'))

    try:
        db.delete_task(task_id)
        flash(f'Task "{task["name"]}" deleted successfully!', 'success')
    except Exception as e:
        flash(f'Error deleting task: {str(e)}', 'error')

    return redirect(url_for('index'))

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5001)
