#!/bin/bash

echo "=== Aranet Reader Status ==="
echo "Service status:"
sudo systemctl status aranet-reader
echo
echo "Last 20 log entries:"
sudo journalctl -u aranet-reader -n 20 