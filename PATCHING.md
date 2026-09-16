# Patching the client

The client has the publisher's addresses built in, so it has to be pointed at
the server. `tools/patch_client.py` does that to a copy of the 1.5.7 apk you
already have and writes a new apk; the one you supply is never modified. It
needs Python 3.9+ and a JDK to sign the result (`keytool` and `jarsigner`, found
on `PATH` or under `JAVA_HOME`).

1. Copy the apk off your device, with USB debugging on:

   ```sh
   adb shell pm path com.tinyco.futurama   # prints package:/data/app/.../base.apk
   adb pull /data/app/.../base.apk fwot-1.5.7.apk
   ```

2. Patch it with the server's address -- the same one it uses as `publicUrl`:

   ```sh
   python tools/patch_client.py fwot-1.5.7.apk --server http://192.0.2.10:8090
   ```

3. If the original is still installed, uninstall it first: the patched apk is
   signed with a different key, so Android will not install it over the
   original. Uninstalling loses the original's local data, which has no server
   to talk to anyway.

   ```sh
   adb uninstall com.tinyco.futurama
   ```

4. Install the result. You may need to grant it storage permissions before the
   first launch.

   ```sh
   adb install fwot-patched.apk
   # Optionally:
   adb shell pm grant com.tinyco.futurama android.permission.READ_EXTERNAL_STORAGE
   adb shell pm grant com.tinyco.futurama android.permission.WRITE_EXTERNAL_STORAGE
   ```

The addresses go into fixed-size slots in the client, so `--server` must be
short: an `https://` host of up to 20 characters, or an `http://` host and port
of up to 21. The patcher refuses one that does not fit.
