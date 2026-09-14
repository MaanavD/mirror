"""Wait for the live frontend before starting Chromium after a Pi boot."""
import sys
import time
import urllib.request

url = sys.argv[1] if len(sys.argv) > 1 else 'http://100.94.66.103:8390/dashboard?view=mirror'
while True:
    try:
        with urllib.request.urlopen(url, timeout=8) as response:
            if response.status == 200 and b'name="mirror-release"' in response.read():
                break
    except (OSError, ValueError):
        pass
    time.sleep(5)
print('Live dashboard available; starting kiosk.', flush=True)
