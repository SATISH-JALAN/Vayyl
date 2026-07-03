import urllib.request
import tarfile
import os
import shutil

url = "https://github.com/stellar/stellar-cli/releases/download/v26.1.0/stellar-cli-26.1.0-x86_64-pc-windows-msvc.tar.gz"
filename = "stellar.tar.gz"

print("Downloading...")
urllib.request.urlretrieve(url, filename)

print("Extracting...")
with tarfile.open(filename, "r:gz") as tar:
    tar.extractall(path="stellar_extracted")

exe_path = None
for root, dirs, files in os.walk("stellar_extracted"):
    for file in files:
        if file == "stellar.exe":
            exe_path = os.path.join(root, file)
            break

if exe_path:
    dest = r"C:\Users\HP\.gemini\antigravity-ide\bin\stellar.exe"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"Copying to {dest}")
    shutil.copy2(exe_path, dest)
    print("Done!")
else:
    print("stellar.exe not found!")
