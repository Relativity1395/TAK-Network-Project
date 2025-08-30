from flask import Flask, request, jsonify
from flask_cors import CORS
import sqlite3
import json

app = Flask(__name__)
CORS(app)

DATABASE_FILE = "geofences.db"

def get_db_connection():
    """Establishes a connection to the database."""
    conn = sqlite3.connect(DATABASE_FILE)
    conn.row_factory = sqlite3.Row # This allows accessing columns by name
    return conn

def init_db():
    """Initializes the database and creates the table if it doesn't exist."""
    with app.app_context():
        conn = get_db_connection()
        with open('schema.sql', 'r') as f:
            conn.executescript(f.read())
        conn.close()
        print("Database initialized.")

@app.route("/api/geofence", methods=["POST"])
def create_geofence():
    data = request.get_json()
    
    # Extract data from the payload
    fence_id = data.get("fence_id")
    name = data.get("properties", {}).get("name")
    notes = data.get("properties", {}).get("notes")
    created_at = data.get("created_at")
    # We'll store the complex coordinates object as a JSON string
    coordinates_str = json.dumps(data.get("shape", {}).get("coordinates"))

    # Insert the new geofence into the database
    conn = get_db_connection()
    conn.execute(
        'INSERT INTO fences (fence_id, name, notes, created_at, coordinates) VALUES (?, ?, ?, ?, ?)',
        (fence_id, name, notes, created_at, coordinates_str)
    )
    conn.commit()
    conn.close()
    
    print(f"Saved geofence '{name}' to the database.")
    return jsonify({"status": "success", "message": "Geofence created and stored"}), 201

@app.route("/api/geofences", methods=["GET"])
def get_geofences():
    conn = get_db_connection()
    fences_rows = conn.execute('SELECT * FROM fences').fetchall()
    conn.close()
    
    # Convert the database rows into a list of dictionaries
    fences_list = [dict(row) for row in fences_rows]
    print(f"Retrieved {len(fences_list)} geofences from the database.")
    return jsonify(fences_list)

if __name__ == "__main__":
    # Create the database and table before starting the server
    # init_db() 
    app.run(host="0.0.0.0", port=5001, debug=True)