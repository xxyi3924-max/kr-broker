#!/usr/bin/env python3
"""
KR Broker — Startup Script
Flask server on port 8084
"""
import subprocess, sys, time, os

def check_port(port):
    try:
        import socket
        s = socket.socket()
        s.settimeout(1)
        s.connect(('127.0.0.1', port))
        s.close()
        return True
    except:
        return False

def main():
    port = 8084

    if check_port(port):
        print(f"⚠️  Port {port} already in use. KR Broker may already be running.")
        print(f"   Open: http://localhost:{port}")
        return

    print("Starting KR Broker on http://localhost:8084")
    print("Press Ctrl+C to stop\n")

    # Start Flask
    srv = subprocess.Popen(
        [sys.executable, 'app.py'],
        cwd=os.path.dirname(os.path.abspath(__file__)),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        bufsize=1,
        text=True,
    )

    time.sleep(2)
    print("✓ KR Broker running at http://localhost:8084\n")

    try:
        for line in srv.stdout:
            print(line, end='')
    except KeyboardInterrupt:
        print("\n\nStopping KR Broker…")
        srv.terminate()
        srv.wait()

if __name__ == '__main__':
    main()
