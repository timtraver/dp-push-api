##
# @author Tim Traver <timtraver@gmail.com>
# @version 1.0
# @see {@link https://github.com/timtraver/dp-push-api}
# @description : This is an API endpoint for push notifications to the expo push notification apis

 
# Getting Started with DigitalPool Push API

This is the node application to start an endpoint for handling push notifications.

## LetsEncrypt certificate needed for https server

This application needs an https certificate to use when serving up the websocket so as to work with secure sites making calls to this server. You will need to install letsencrypt on the local server, and use the following command to create a certificate for the domain name that points to this server.

### ```sudo snap install --classic certbot```
### ```sudo ln -s /snap/bin/certbot /usr/bin/certbot```
### ```sudo certbot certonly --standalone```

During the certbot process, you need to enter the fully qualified domain name that will be used for the cert.

### config.json

Use this file to set the coniguration for the node repeater server.
The parameters are as follows
- apiFQDN : the fully qualified domain name to be used for the created certificate (same as created in the certbot process)
- apiIpAddress : the local IP Address to bind to for the server
- apiPort : the local port to be used (should be 8443 or higher than the reserved ports becuase it is being run by non root user)
- httpsKeyPath : path to letsencrypt key
- httpsCertPath : path to letsencrypt cert
- pgConnectionString : the full postgres connection string to the database for user lookups
- sharedSecret : the shared secret to whatever code is going to be calling this api. Extra layer of security to prevent abuse.

## Additional local config

After you have done all of that setup, you need to create a user to run the node server as (pushapi), and change the permissions on all the files to be pushapi:pushapi

### ```useradd -d /home/dp-push-api pushapi```
### ```chown -R pushapi:pushapi dp-push-api```

You will need to create a systemd service to start the node server and run as the user

### `apt install nodejs`
### `apt install npm`
### `npm install`
### `chmod -R 755 /etc/letsencrypt/archive /etc/letsencrypt/live`
### `cd /lib/systemd/system`
### `vi pushapi.service`

and put the following into the pushapi.service file
[Unit]
Description=Digital Pool Push Notification API Server
After=network.target

[Service]
Type=simple
User=pushapi
ExecStart=/usr/bin/node /home/dp-push-api/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target

### `systemctl enable pushapi`

## Available Scripts

In the project directory, you can run it manually:

### `npm start`

Runs the app manually based on the config values in config.json

Or you can start the service

### `systemctl start pushapi`
