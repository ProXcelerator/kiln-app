import sys, json, os, tempfile

try:
    with open('server/data/settings.json') as f:
        settings = json.load(f)
except Exception as e:
    print("Failed to load settings.json:", e)
    sys.exit(1)

email = settings.get('emporiaEmail')
password = settings.get('emporiaPassword')

if not email or not password:
    print("No Emporia credentials in settings.json.")
    sys.exit(1)

try:
    import pyemvue
    from pyemvue.enums import Scale, Unit
except ImportError:
    print("pyemvue not installed.")
    sys.exit(1)

vue = pyemvue.PyEmVue()
token_file = os.path.join(tempfile.gettempdir(), 'emporia_keys.json')

print(f"Attempting to log into Emporia as '{email}'...")

try:
    vue.login(username=email, password=password, token_storage_file=token_file)
    print("Success! Logged in.")
except Exception as e:
    print("\nLOGIN FAILED:")
    print(str(e))
    sys.exit(1)

devices = vue.get_devices()
print(f"\nFound {len(devices)} device(s) on account.")

if not devices:
    sys.exit(0)

# Fetch usage data to see channels actively reporting
usage_data = vue.get_device_list_usage(
    deviceGids=[d.device_gid for d in devices],
    instant=None,
    scale=Scale.MINUTE.value,
    unit=Unit.KWH.value
)

for d in devices:
    print(f"\n=====================================")
    print(f"DEVICE: {d.device_name}")
    print(f"GID:    {d.device_gid}")
    print(f"Model:  {d.model}")
    print(f"=====================================")
    
    usage = usage_data.get(d.device_gid)
    if usage and hasattr(usage, 'channels') and usage.channels:
        for ch_num, ch_data in usage.channels.items():
            name = getattr(ch_data, 'name', 'Unknown')
            val = getattr(ch_data, 'usage', 0)
            watts = (val * 1000 * 60) if val else 0
            print(f"  [Channel {ch_num}] {name}  =>  {round(watts, 1)} W currently")
    else:
        print("  (No active channels found reporting usage data for this device)")

print("\nDiagnostic complete.")
