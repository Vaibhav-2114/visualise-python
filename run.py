#!/usr/bin/env python3
"""CLI entry point to launch the Python Visualizer server."""

import argparse
import sys
from backend.server import create_server


def main():
    parser = argparse.ArgumentParser(description="Run the Python Visualizer server.")
    parser.add_argument(
        "--host",
        type=str,
        default="0.0.0.0",
        help="Host address to bind the HTTP server to (default: 0.0.0.0)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port number to listen on (default: 8000)",
    )
    args = parser.parse_args()

    server = create_server(host=args.host, port=args.port)
    actual_port = server.server_address[1]
    print(f"Python Visualizer server running at http://{args.host}:{actual_port}/")
    print("Press Ctrl+C to stop.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
    finally:
        server.server_close()
        print("Server stopped cleanly.")


if __name__ == "__main__":
    main()
