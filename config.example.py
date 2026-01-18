# Orchestra Configuration Example
# Copy this file to config.py and update with your settings

# API Configuration
API_URL = "http://192.168.1.2:8080/api/v1/chat/completions"
API_KEY = ""  # Leave empty if local auth is disabled, otherwise add your Bearer token

# Default Task Settings
# These are used as fallbacks if tasks don't specify model or workspace
DEFAULT_MODEL = "deepseek-r1:latest"
DEFAULT_WORKSPACE = "default"

# Directory Configuration
TASKS_DIRECTORY = "./tasks"
PENDING_DIRECTORY = "./tasks/pending"
COMPLETED_DIRECTORY = "./tasks/completed"
FAILED_DIRECTORY = "./tasks/failed"

# Request Configuration
REQUEST_TIMEOUT = 300  # seconds to wait for API response
