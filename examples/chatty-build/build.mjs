// A deliberately chatty "build" used to demo whocalls. Everything it contacts is harmless:
// public package metadata, a public text file, and example.com.
import net from 'node:net';

const get = async (url) => (await fetch(url)).arrayBuffer();

// 1. A normal dependency lookup.
await get('https://registry.npmjs.org/left-pad');

// 2. Fetching a script from GitHub, as many build steps do.
await get('https://raw.githubusercontent.com/Nithinfgs/whocalls/main/LICENSE');

// 3. A plain-HTTP request, which anyone on the path can read.
await get('http://example.com/');

// 4. A client that ignores proxy settings, like some JVM tools and hand-rolled sockets.
await new Promise((resolve) => {
  const socket = net.connect(80, 'example.com', () => {
    socket.write('HEAD / HTTP/1.0\r\nHost: example.com\r\n\r\n');
    setTimeout(() => (socket.destroy(), resolve()), 600);
  });
  socket.on('error', resolve);
});

console.log('build finished');
