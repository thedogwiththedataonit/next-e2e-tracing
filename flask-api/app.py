from flask import Flask, jsonify
from flask_cors import CORS

app = Flask(__name__)
# Enable CORS for all routes
CORS(app)

@app.route('/')
def home():
    """Root endpoint"""
    return jsonify({
        'message': 'Flask API is running!',
        'endpoints': {
            '/': 'This endpoint',
            '/health': 'Health check',
            '/api/data': 'Get sample data'
        }
    }), 200

@app.route('/health')
def health():
    """Health check endpoint"""
    return jsonify({
        'status': 'healthy',
        'message': 'API is running'
    }), 200

@app.route('/api/data')
def get_data():
    """Data endpoint that returns sample JSON data"""
    return jsonify({
        'data': [
            {
                'id': 1,
                'name': 'Item 1',
                'description': 'This is the first item',
                'value': 100
            },
            {
                'id': 2,
                'name': 'Item 2',
                'description': 'This is the second item',
                'value': 200
            },
            {
                'id': 3,
                'name': 'Item 3',
                'description': 'This is the third item',
                'value': 300
            }
        ],
        'total_items': 3,
        'timestamp': '2025-09-19T00:00:00Z'
    }), 200

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, debug=True)
