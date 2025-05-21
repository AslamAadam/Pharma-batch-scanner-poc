It's a pure browser js solution.

We use node.js only to provide https services, you can use any other web servers like Nginx, IIS, Apache.

The page is in the `public` folder.

Run node.js server.
```
npm i
node app.js
```

The code you should focus on mainly is in the first few lines of `dps.js`.

Set the path to the assets folder:
```js
Dynamsoft.Core.CoreModule.engineResourcePaths.rootDirectory = 'path/to/assets'
```
