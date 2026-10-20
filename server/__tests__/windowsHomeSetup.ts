// Windows only: os.homedir() reads USERPROFILE, but many server tests redirect
// the home directory by setting process.env.HOME (which POSIX os.homedir()
// honors). Without this shim those tests fail on Windows AND write into the
// developer's real ~/.pixel-agents. Mirror HOME into USERPROFILE so both
// platforms behave the same.
if (process.platform === 'win32') {
  const realEnv = process.env;
  const originalProfile = realEnv.USERPROFILE;
  process.env = new Proxy(realEnv, {
    set(target, prop, value) {
      if (prop === 'HOME') target.USERPROFILE = String(value);
      target[prop as string] = value;
      return true;
    },
    deleteProperty(target, prop) {
      if (prop === 'HOME') {
        if (originalProfile === undefined) delete target.USERPROFILE;
        else target.USERPROFILE = originalProfile;
      }
      delete target[prop as string];
      return true;
    },
  });
}
