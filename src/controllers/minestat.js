'use strict';

const NUM_FIELDS = 6;   // number of values expected from server
const address = null;
const port = null;
const online = null;          // online or offline?
const version = null;         // server version
const motd = null;            // message of the day
const current_players = null; // current number of players online
const max_players = null;     // maximum player capacity

class Minestat {
    
  init(address, port, callback){
    this.address = address;
    this.port = port;

    const net = require('net');
    const client = net.connect(port, address, () =>
    {
      var buff = new Buffer([ 0xFE, 0x01 ]);
      client.write(buff);
    });

    // Set timeout to 5 seconds
    client.setTimeout(5000);

    client.on('data', (data) =>
    {
      if(data != null && data != '')
      {
        var server_info = data.toString().split("\x00\x00\x00");
        if(server_info != null && server_info.length >= NUM_FIELDS)
        {
          this.online = true;
          this.version = server_info[2].replace(/\u0000/g,'');
          this.motd = server_info[3].replace(/\u0000/g,'');
          this.current_players = server_info[4].replace(/\u0000/g,'');
          this.max_players = server_info[5].replace(/\u0000/g,'');
        }
        else
        {
          this.online = false;
        }
      }
      callback();
      client.end();
    });

    client.on('timeout', () =>
    {
      callback();
      client.end();
      process.exit();
    });

    client.on('end', () =>
    {
      // nothing needed here
    });

    client.on('error', (err) =>
    {
      // Uncomment the lines below to handle error codes individually. Otherwise,
      // call callback() and simply report the remote server as being offline.

      /*
      if(err.code == "ENOTFOUND")
      {
        console.log("Unable to resolve " + this.address + ".");
        return;
      }
      if(err.code == "ECONNREFUSED")
      {
        console.log("Unable to connect to port " + this.port + ".");
        return;
      }
      */

      callback();

      // Uncomment the line below for more details pertaining to network errors.
      //console.log(err);
    });
  }
};