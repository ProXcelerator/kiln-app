#!/usr/bin/env python3
"""
read_emporia.py — Emporia Vue power monitoring via pyemvue
Requires: pip install pyemvue

Environment variables (set by Node.js parent):
  EMPORIA_EMAIL      — your Emporia account email
  EMPORIA_PASSWORD   — your Emporia account password
  EMPORIA_DEVICE_GID — device GID (optional, uses first device if not set)
  EMPORIA_CHANNEL    — channel number (default: 1 = main panel)

Output: JSON to stdout:  {"watts": 2347}
"""

import sys
import os
import json
import tempfile

try:
    import pyemvue
    from pyemvue.enums import Scale, Unit

    email = os.environ.get('EMPORIA_EMAIL', '')
    password = os.environ.get('EMPORIA_PASSWORD', '')
    device_gid_env = os.environ.get('EMPORIA_DEVICE_GID', '')
    channel_num = int(os.environ.get('EMPORIA_CHANNEL', '1'))

    if not email or not password:
        print(json.dumps({"error": "No credentials", "watts": None}))
        sys.exit(0)

    vue = pyemvue.PyEmVue()
    token_file = os.path.join(tempfile.gettempdir(), 'emporia_keys.json')
    vue.login(username=email, password=password, token_storage_file=token_file)

    devices = vue.get_devices()
    if not devices:
        print(json.dumps({"error": "No devices", "watts": None}))
        sys.exit(0)

    # Find device
    if device_gid_env:
        device_gid = int(device_gid_env)
        target_device = next((d for d in devices if d.device_gid == device_gid), devices[0])
    else:
        target_device = devices[0]

    # Fetch last-minute usage in kWh, convert to watts
    usage_data = vue.get_device_list_usage(
        deviceGids=[target_device.device_gid],
        instant=None,
        scale=Scale.MINUTE.value,
        unit=Unit.KWH.value
    )

    device_usage = usage_data.get(target_device.device_gid)
    if not device_usage:
        print(json.dumps({"error": "No usage data", "watts": None}))
        sys.exit(0)

    # Channel 1 = whole home; find target channel
    channels = device_usage.channels if hasattr(device_usage, 'channels') else {}
    
    # Try to get channel data
    channel_key = str(channel_num)
    kwh_per_minute = None

    if hasattr(device_usage, 'usage') and device_usage.usage is not None:
        kwh_per_minute = device_usage.usage
    elif channel_key in channels:
        ch = channels[channel_key]
        kwh_per_minute = ch.usage if hasattr(ch, 'usage') else None

    if kwh_per_minute is None:
        print(json.dumps({"error": "No channel usage", "watts": None}))
        sys.exit(0)

    # kWh per minute → watts
    watts = kwh_per_minute * 1000 * 60

    print(json.dumps({"watts": round(watts, 1), "device": target_device.device_name}))
    sys.exit(0)

except ImportError:
    print(json.dumps({"error": "pyemvue not installed. Run: pip install pyemvue", "watts": None}))
    sys.exit(1)

except Exception as e:
    print(json.dumps({"error": str(e), "watts": None}))
    sys.exit(1)
