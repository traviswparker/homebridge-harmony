DEFAULT_HUB_PORT = '8088';
TIMEOUT_REFRESH_CURRENT_ACTIVITY = 1500;
CURRENT_ACTIVITY_NOT_SET_VALUE = -9999;
MAX_ATTEMPS_STATUS_UPDATE = 12;
DELAY_BETWEEN_ATTEMPS_STATUS_UPDATE = 2000;
DELAY_TO_UPDATE_STATUS = 800;
DELAY_TO_RELAUNCH_TIMER = 8000;
DELAY_FOR_COMMAND = '100';

var Service, Characteristic;
var request = require('request');
const url = require('url');
const W3CWebSocket = require('websocket').w3cwebsocket;
const WebSocketAsPromised = require('websocket-as-promised');

module.exports = {
  HarmonyPlatformAsTVPlatform: HarmonyPlatformAsTVPlatform,
};

function HarmonyPlatformAsTVPlatform(log, config, api) {
  Service = api.hap.Service;
  Characteristic = api.hap.Characteristic;

  this.log = log;
  this.hubIP = config['hubIP'];

  this.name = config['name'];
  this.devMode = config['DEVMODE'];
  this.refreshTimer = config['refreshTimer'];
  this.mainActivity = config['mainActivity'];

  this._currentActivity = -9999;
  this._currentActivityLastUpdate = undefined;
  this._currentSetAttemps = 0;
  this._foundAccessories = [];

  if (
    this.refreshTimer &&
    this.refreshTimer > 0 &&
    (this.refreshTimer < 5 || this.refreshTimer > 600)
  )
    this.refreshTimer = 300;

  if (api) {
    // Save the API object as plugin needs to register new accessory via this object
    this.api = api;
    var that = this;
    this.api.on(
      'shutdown',
      function() {
        that.log('shutdown');
        if (that.timerID) {
          clearInterval(that.timerID);
          that.timerID = undefined;
        }
      }.bind(this)
    );
  }
}

HarmonyPlatformAsTVPlatform.prototype = {
  setTimer: function(on) {
    if (this.refreshTimer && this.refreshTimer > 0) {
      if (on && this.timerID == undefined) {
        this.log.debug(
          'INFO - setTimer - Setting Timer for background refresh every  : ' +
            this.refreshTimer +
            's'
        );
        this.timerID = setInterval(
          () => this.refreshAccessory(),
          this.refreshTimer * 1000
        );
      } else if (!on && this.timerID !== undefined) {
        this.log.debug('INFO - setTimer - Clearing Timer');
        clearInterval(this.timerID);
        this.timerID = undefined;
      }
    }
  },

  ///CREATION / STARTUP

  configureMainActivity: function(activity, services) {
    let inputName = activity.label;
    if (this.devMode) {
      inputName = 'DEV' + inputName;
    }
    this.log('Configuring Main Activity ' + inputName);

    this.mainActivityId = activity.id;
    this.mainService.activityName = inputName;
    this.mainService.activityId = activity.id;
    this.mainService.controlService.id = 'M' + activity.id;

    this.log('Creating TV Speaker Service');
    this.tvSpeakerService = {
      controlService: new Service.TelevisionSpeaker(this.name, 'TVSpeaker'),
      characteristics: [
        Characteristic.Mute,
        Characteristic.VolumeSelector,
        Characteristic.Volume,
      ],
    };
    this.tvSpeakerService.controlService
      .setCharacteristic(Characteristic.Active, Characteristic.Active.ACTIVE)
      .setCharacteristic(
        Characteristic.VolumeControlType,
        Characteristic.VolumeControlType.RELATIVE
      );

    this.tvSpeakerService.controlService.id = 'V' + activity.id;
    this.tvSpeakerService.controlService.subtype = this.name + ' Volume';
    this.mainService.controlService.addLinkedService(
      this.tvSpeakerService.controlService
    );
    services.push(this.tvSpeakerService);
  },

  accessories: function(callback) {
    this.log('Loading activities...');

    var that = this;

    let headers = {
      Origin: 'http://localhost.nebula.myharmony.com',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Accept-Charset': 'utf-8',
    };

    let hubUrl = `http://${this.hubIP}:${DEFAULT_HUB_PORT}/`;

    let jsonBody = {
      'id ': 1,
      cmd: 'connect.discoveryinfo?get',
      params: {},
    };

    request(
      {
        url: hubUrl,
        method: 'POST',
        headers: headers,
        body: jsonBody,
        json: true,
      },
      function(error, response, body) {
        if (error) {
          that.log('Error retrieving info from hub : ' + error.message);
        } else if (response && response.statusCode !== 200) {
          that.log(
            'Did not received 200 statuts, but  ' +
              response.statusCode +
              ' instead from hub'
          );
        } else if (body && body.data) {
          that.friendlyName = body.data.friendlyName;
          that.remote_id = body.data.remoteId;
          that.domain = url.parse(body.data.discoveryServerUri).hostname;
          that.email = body.data.email;
          that.account_id = body.data.accountId;

          wsUrl = `ws://${that.hubIP}:${DEFAULT_HUB_PORT}/?domain=${
            that.domain
          }&hubId=${that.remote_id}`;

          that.wsp = new WebSocketAsPromised(wsUrl, {
            createWebSocket: url => new W3CWebSocket(url),
            packMessage: data => JSON.stringify(data),
            unpackMessage: message => JSON.parse(message),
            attachRequestId: (data, requestId) => {
              data.hbus.id = requestId;
              return data;
            },
            extractRequestId: data => data && data.id,
          });

          payload = {
            hubId: that.remote_id,
            timeout: 30,
            hbus: {
              cmd: `vnd.logitech.harmony/vnd.logitech.harmony.engine?config`,
              id: 0,
              params: {
                verb: 'get',
                format: 'json',
              },
            },
          };

          that.wsp
            .open()
            .then(() =>
              that.wsp.onUnpackedMessage.addListener(data => {
                that.wsp.removeAllListeners();

                that.log.debug(
                  'INFO - accessories : Hub config : ' + JSON.stringify(data)
                );
                let activities = data.data.activity;

                let services = [];

                that.log('Creating Main TV Service');
                that.mainService = {
                  controlService: new Service.Television(
                    that.name,
                    'tvService'
                  ),
                  characteristics: [
                    Characteristic.Active,
                    Characteristic.ActiveIdentifier,
                    Characteristic.RemoteKey,
                  ],
                };
                that.mainService.controlService.subtype = that.name + ' TV';
                that.mainService.controlService
                  .setCharacteristic(Characteristic.ConfiguredName, that.name)
                  .setCharacteristic(
                    Characteristic.SleepDiscoveryMode,
                    Characteristic.SleepDiscoveryMode.ALWAYS_DISCOVERABLE
                  )
                  .setCharacteristic(Characteristic.ActiveIdentifier, -1)
                  .setCharacteristic(Characteristic.Active, false);

                that.inputServices = [];
                that.log.debug(
                  'INFO - accessories : main activity name : ' +
                    that.mainActivity
                );
                let mainActivityConfigured = false;

                for (let i = 0, len = activities.length; i < len; i++) {
                  if (activities[i].id != -1) {
                    let inputName = activities[i].label;
                    if (that.devMode) {
                      inputName = 'DEV' + inputName;
                    }
                    that.log.debug(
                      'INFO - accessories : activity to configure : ' +
                        inputName
                    );
                    if (that.mainActivity == inputName) {
                      that.configureMainActivity(activities[i], services);
                      mainActivityConfigured = true;
                    }

                    that.log('Creating InputSourceService ' + inputName);
                    let inputSourceService = {
                      controlService: new Service.InputSource(
                        inputName,
                        'Input'
                      ),
                      characteristics: [],
                    };
                    inputSourceService.controlService.id = activities[i].id;
                    inputSourceService.activityName = inputName;
                    inputSourceService.activityId = activities[i].id;
                    inputSourceService.controlService.subtype =
                      inputName + ' Activity';

                    //keys
                    let controlGroup = activities[i].controlGroup;
                    for (let j = 0, len = controlGroup.length; j < len; j++) {
                      let functions = controlGroup[j].function;
                      if (controlGroup[j].name == 'Volume') {
                        for (let k = 0, len = functions.length; k < len; k++) {
                          if (functions[k].name == 'Mute') {
                            that.log('Mapping Mute for ' + inputName);
                            inputSourceService.MuteCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'VolumeDown') {
                            that.log('Mapping VolumeDown for ' + inputName);
                            inputSourceService.VolumeDownCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'VolumeUp') {
                            that.log('Mapping VolumeUp for ' + inputName);
                            inputSourceService.VolumeUpCommand =
                              functions[k].action;
                          }
                        }
                      } else if (
                        activities[i].controlGroup[j].name == 'NavigationBasic'
                      ) {
                        for (let k = 0, len = functions.length; k < len; k++) {
                          if (functions[k].name == 'DirectionDown') {
                            that.log('Mapping DirectionDown for ' + inputName);
                            inputSourceService.DirectionDownCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'DirectionLeft') {
                            that.log('Mapping DirectionLeft for ' + inputName);
                            inputSourceService.DirectionLeftCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'DirectionRight') {
                            that.log('Mapping DirectionRight for ' + inputName);
                            inputSourceService.DirectionRightCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'DirectionUp') {
                            that.log('Mapping DirectionUp for ' + inputName);
                            inputSourceService.DirectionUpCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'Select') {
                            that.log('Mapping Select for ' + inputName);
                            inputSourceService.SelectCommand =
                              functions[k].action;
                          }
                        }
                      } else if (
                        activities[i].controlGroup[j].name == 'TransportBasic'
                      ) {
                        for (let k = 0, len = functions.length; k < len; k++) {
                          if (functions[k].name == 'Stop') {
                            that.log('Mapping Stop for ' + inputName);
                            inputSourceService.StopCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'Play') {
                            that.log('Mapping Play for ' + inputName);
                            inputSourceService.PlayCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'Rewind') {
                            that.log('Mapping Rewind for ' + inputName);
                            inputSourceService.RewindCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'Pause') {
                            that.log('Mapping Pause for ' + inputName);
                            inputSourceService.PauseCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'FastForward') {
                            that.log('Mapping FastForward for ' + inputName);
                            inputSourceService.FastForwardCommand =
                              functions[k].action;
                          }
                        }
                      } else if (
                        activities[i].controlGroup[j].name == 'NavigationDVD'
                      ) {
                        for (let k = 0, len = functions.length; k < len; k++) {
                          if (
                            functions[k].name == 'Return' ||
                            functions[k].name == 'Back'
                          ) {
                            that.log('Mapping Return for ' + inputName);
                            inputSourceService.ReturnCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'Menu') {
                            that.log('Mapping Menu for ' + inputName);
                            inputSourceService.MenuCommand =
                              functions[k].action;
                          }
                        }
                      } else if (
                        activities[i].controlGroup[j].name ==
                        'TransportExtended'
                      ) {
                        for (let k = 0, len = functions.length; k < len; k++) {
                          if (functions[k].name == 'SkipBackward') {
                            that.log('Mapping SkipBackward for ' + inputName);
                            inputSourceService.SkipBackwardCommand =
                              functions[k].action;
                          } else if (functions[k].name == 'SkipForward') {
                            that.log('Mapping SkipForward for ' + inputName);
                            inputSourceService.SkipForwardCommand =
                              functions[k].action;
                          }
                        }
                      } else if (
                        activities[i].controlGroup[j].name == 'GameType3'
                      ) {
                        for (let k = 0, len = functions.length; k < len; k++) {
                          if (functions[k].name == 'Home') {
                            that.log('Mapping Home for ' + inputName);
                            inputSourceService.HomeCommand =
                              functions[k].action;
                          }
                        }
                      }
                    }

                    inputSourceService.controlService
                      .setCharacteristic(
                        Characteristic.Identifier,
                        activities[i].id
                      )
                      .setCharacteristic(
                        Characteristic.ConfiguredName,
                        inputName
                      )
                      .setCharacteristic(
                        Characteristic.IsConfigured,
                        Characteristic.IsConfigured.CONFIGURED
                      )
                      .setCharacteristic(
                        Characteristic.InputSourceType,
                        Characteristic.InputSourceType.APPLICATION
                      )
                      .setCharacteristic(
                        Characteristic.CurrentVisibilityState,
                        Characteristic.CurrentVisibilityState.SHOWN
                      );

                    that.mainService.controlService.addLinkedService(
                      inputSourceService.controlService
                    );
                    services.push(inputSourceService);
                    that.inputServices.push(inputSourceService);
                  }
                }

                if (!mainActivityConfigured) {
                  that.log(
                    'WARNING - No main Activity that match config file found, default to first one'
                  );
                  that.configureMainActivity(activities[0], services);
                }

                services.push(that.mainService);

                that.log('Adding Accessory : ' + that.name);
                let myHarmonyAccessory = new HarmonyAccessory(services);
                myHarmonyAccessory.getServices = function() {
                  return that.getServices(myHarmonyAccessory);
                };
                myHarmonyAccessory.platform = that;
                myHarmonyAccessory.name = that.name;
                myHarmonyAccessory.model = that.name;
                myHarmonyAccessory.manufacturer = 'Harmony';
                myHarmonyAccessory.serialNumber = that.hubIP;
                that._foundAccessories.push(myHarmonyAccessory);

                //first refresh
                that.refreshAccessory();

                //timer for background refresh
                that.setTimer(true);

                callback(that._foundAccessories);
              })
            )
            .then(() => that.wsp.sendPacked(payload))
            .catch(e => {
              that.log('ERROR - accessories : GetConfiguration :' + e);
              callback(that._foundAccessories);
            });
        } else {
          that.log(
            'Error - accessories : No config retrieved from hub, check IP and connectivity'
          );
          callback(that._foundAccessories);
        }
      }
    );
  },

  ///REFRESHING TOOLS

  refreshAccessory: function() {
    this.refreshCharacteristic(
      this.mainService.controlService.getCharacteristic(
        Characteristic.ActiveIdentifier
      ),
      () => {
        this.refreshCharacteristic(
          this.mainService.controlService.getCharacteristic(
            Characteristic.Active
          ),
          undefined
        );
      }
    );
  },

  refreshCharacteristic: function(characteristic, callback) {
    this.refreshCurrentActivity(() => {
      if (this._currentActivity > CURRENT_ACTIVITY_NOT_SET_VALUE) {
        if (characteristic instanceof Characteristic.Active) {
          this.log.debug(
            'INFO - refreshCharacteristic : updating Characteristic.Active to ' +
              (this._currentActivity != -1)
          );
          this.updateCharacteristic(
            characteristic,
            this._currentActivity > 0,
            callback
          );
        } else if (characteristic instanceof Characteristic.ActiveIdentifier) {
          this.log.debug(
            'INFO - refreshCharacteristic : updating Characteristic.ActiveIdentifier to ' +
              this._currentActivity
          );
          this.updateCharacteristic(
            characteristic,
            this._currentActivity,
            callback
          );
        }
      } else {
        this.log.debug('WARNING - refreshCharacteristic : no current Activity');
        if (characteristic instanceof Characteristic.Active) {
          this.updateCharacteristic(characteristic, false, callback);
        } else if (characteristic instanceof Characteristic.ActiveIdentifier) {
          this.updateCharacteristic(characteristic, -1, callback);
        }
      }
    });
  },

  refreshCurrentActivity: function(callback) {
    if (
      this._currentActivity > CURRENT_ACTIVITY_NOT_SET_VALUE &&
      this._currentActivityLastUpdate &&
      Date.now() - this._currentActivityLastUpdate <
        TIMEOUT_REFRESH_CURRENT_ACTIVITY
    ) {
      // we don't refresh since status was retrieved not so far away
      this.log.debug(
        'INFO - refreshCurrentActivity : NO refresh needed since last update was on :' +
          this._currentActivity +
          ' and current Activity is set'
      );
      callback();
    } else {
      this.log.debug(
        'INFO - refreshCurrentActivity : Refresh needed since last update is too old or current Activity is not set : ' +
          this._currentActivity
      );

      payload = {
        hubId: this.remote_id,
        timeout: 30,
        hbus: {
          cmd:
            'vnd.logitech.harmony/vnd.logitech.harmony.engine?getCurrentActivity',
          id: 0,
          params: {
            verb: 'get',
            format: 'json',
          },
        },
      };

      this.wsp
        .open()
        .then(() =>
          this.wsp.onUnpackedMessage.addListener(data => {
            this.wsp.removeAllListeners();

            if (
              data &&
              data.data &&
              data.code &&
              (data.code == 200 || data.code == 100)
            ) {
              this.updateCurrentInputService(data.data.result);
            } else {
              this.log.debug(
                'WARNING - refreshCurrentActivity : could not refresh current Activity :' +
                  (data ? JSON.stringify(data) : 'no data')
              );
              this.updateCurrentInputService(CURRENT_ACTIVITY_NOT_SET_VALUE);
            }
            callback();
          })
        )
        .then(() => this.wsp.sendPacked(payload))
        .catch(e => {
          this.log(
            'ERROR - refreshCurrentActivity : RefreshCurrentActivity : ' + e
          );
          this.updateCurrentInputService(CURRENT_ACTIVITY_NOT_SET_VALUE);
          callback();
        });
    }
  },

  updateCurrentInputService: function(newActivity) {
    if (!newActivity) return;

    this._currentActivity = newActivity;
    this._currentActivityLastUpdate = Date.now();

    if (this._currentActivity > CURRENT_ACTIVITY_NOT_SET_VALUE) {
      for (let i = 0, len = this.inputServices.length; i < len; i++) {
        if (this.inputServices[i].activityId == this._currentActivity) {
          this._currentInputService = this.inputServices[i];
          break;
        }
      }
    } else {
      this._currentInputService = -1;
    }
  },

  updateCharacteristic: function(characteristic, value, callback) {
    try {
      if (callback) {
        callback(undefined, value);
      } else {
        characteristic.updateValue(value);
      }
    } catch (error) {
      characteristic.updateValue(value);
    }
  },

  ///COMANDS
  sendInputCommand: function(homebridgeAccessory, value) {
    let doCommand = true;
    let commandToSend = value;

    let inputName = '';
    for (let i = 0, len = this.inputServices.length; i < len; i++) {
      if (this.inputServices[i].activityId == commandToSend) {
        inputName = this.inputServices[i].activityName;
        break;
      }
    }

    //GLOBAL OFF SWITCH : do command only if we are not off
    if (commandToSend == -1) {
      doCommand =
        this._currentActivity != -1 &&
        this._currentActivity > CURRENT_ACTIVITY_NOT_SET_VALUE;
    }
    //ELSE, we do the command only if state is different.
    else {
      doCommand = this._currentActivity !== value;
    }
    if (doCommand) {
      this.log.debug(
        'INFO - sendInputCommand : Activty ' + inputName + ' will be activated '
      );
    } else {
      this.log.debug(
        'INFO - sendInputCommand : Activty ' +
          inputName +
          ' will not be activated '
      );
    }

    if (doCommand) {
      homebridgeAccessory.platform.activityCommand(
        homebridgeAccessory,
        commandToSend
      );
    } else {
      var that = this;
      setTimeout(function() {
        that.refreshAccessory();
      }, DELAY_TO_UPDATE_STATUS);
    }
  },

  activityCommand: function(homebridgeAccessory, commandToSend) {
    //timer for background refresh
    this.setTimer(false);
    var params = {
      async: 'false',
      timestamp: 0,
      args: {
        rule: 'start',
      },
      activityId: commandToSend,
    };

    var payload = {
      hubId: this.remote_id,
      timeout: 30,
      hbus: {
        cmd: 'harmony.activityengine?runactivity',
        id: 0,
        params: params,
      },
    };

    this.log.debug(
      'INFO - activityCommand : sending command ' + JSON.stringify(params)
    );

    this.wsp
      .open()
      .then(() =>
        this.wsp.onUnpackedMessage.addListener(data => {
          this.wsp.removeAllListeners();

          this.log.debug(
            'INFO - activityCommand : Returned from hub ' + JSON.stringify(data)
          );

          if (
            data &&
            data.code &&
            data.code == 200 &&
            data.msg &&
            data.msg == 'OK'
          ) {
            this._currentSetAttemps = 0;

            this.log.debug('INFO - activityCommand : command sent');

            this.updateCurrentInputService(params.activityId);

            if (this._currentActivity != -1) {
              this.log.debug(
                'updating characteristics to ' + this._currentActivity
              );

              this.updateCharacteristic(
                this.mainService.controlService.getCharacteristic(
                  Characteristic.ActiveIdentifier
                ),
                this._currentActivity
              );
              this.updateCharacteristic(
                this.mainService.controlService.getCharacteristic(
                  Characteristic.Active
                ),
                true
              );
            } else {
              this.log.debug('updating characteristics to off');

              this.updateCharacteristic(
                this.mainService.controlService.getCharacteristic(
                  Characteristic.Active
                ),
                false
              );

              this.updateCharacteristic(
                this.mainService.controlService.getCharacteristic(
                  Characteristic.ActiveIdentifier
                ),
                -1
              );
            }
            //timer for background refresh - we delay it since activity can take some time to get up
            var that = this;
            setTimeout(function() {
              that.setTimer(true);
            }, DELAY_TO_RELAUNCH_TIMER);
          } else if (data && (data.code == 202 || data.code == 100)) {
            this._currentSetAttemps = this._currentSetAttemps + 1;
            //get characteristic
            this.log.debug(
              'WARNING - activityCommand : could not SET status : ' +
                JSON.stringify(data)
            );

            //we try again with a delay of 1sec since an activity is in progress and we couldn't update the one.
            var that = this;
            setTimeout(function() {
              if (that._currentSetAttemps < MAX_ATTEMPS_STATUS_UPDATE) {
                that.log.debug(
                  'INFO - activityCommand : RETRY to send command ' +
                    params.activityId
                );
                that.activityCommand(homebridgeAccessory, commandToSend);
              } else {
                that.log(
                  'ERROR - activityCommand : could not SET status, no more RETRY : ' +
                    +params.activityId
                );
                that.refreshAccessory();
                //timer for background refresh
                that.setTimer(true);
              }
            }, DELAY_BETWEEN_ATTEMPS_STATUS_UPDATE);
          } else {
            this.log('ERROR - activityCommand : could not SET status, no data');
            //timer for background refresh
            this.setTimer(true);
          }
        })
      )
      .then(() => this.wsp.sendPacked(payload))
      .catch(e => {
        this.log('ERROR - activityCommand : ' + e);
        //timer for background refresh
        this.setTimer(true);
      });
  },

  sendCommand: function(commandToSend) {
    if (!commandToSend) {
      this.log.debug('INFO - sendCommand : Command not available ');
      return;
    }

    this.setTimer(false);

    var payload = {
      hubId: this.remote_id,
      timeout: 30,
      hbus: {
        cmd: 'vnd.logitech.harmony/vnd.logitech.harmony.engine?holdAction',
        id: 0,
        params: {
          status: 'press',
          timestamp: '0',
          verb: 'render',
          action: commandToSend,
        },
      },
    };

    this.log.debug(
      'INFO - sendCommand : sending press command  ' + JSON.stringify(payload)
    );

    this.wsp
      .open()
      .then(() => this.wsp.sendPacked(payload))
      .then(() => {
        this.log.debug('INFO - sendCommand release config ');
        payload.hbus.params.status = 'release';
        payload.hbus.params.timestamp = '50';
      })
      .then(() => {
        this.log.debug(
          'INFO - sendCommand2 : sending release command  ' +
            JSON.stringify(payload)
        );
        this.wsp
          .open()
          .then(() => this.wsp.sendPacked(payload))
          .then(() => {
            this.log.debug('INFO - sendCommand2 done');
            this.setTimer(true);
          })
          .catch(e => {
            this.log('ERROR : sendCommand2 release :' + e);
            //timer for background refresh
            this.setTimer(true);
          });
      })
      .catch(e => {
        this.log('ERROR : sendCommand press :' + e);
        //timer for background refresh
        this.setTimer(true);
      });
  },

  //HOMEKIT CHARACTERISTICS EVENTS
  bindCharacteristicEvents: function(
    characteristic,
    service,
    homebridgeAccessory
  ) {
    if (characteristic instanceof Characteristic.Active) {
      //set to main activity / activeIdentifier or off
      characteristic.on(
        'set',
        function(value, callback) {
          this.log.debug('INFO - SET Characteristic.Active ' + value);

          if (value == 0) {
            this.log.debug('INFO - switching off');
            this.sendInputCommand(homebridgeAccessory, '-1');

            callback(null);
          } else {
            this.refreshCurrentActivity(() => {
              if (this._currentActivity < 0) {
                let activityToLaunch = service.controlService.getCharacteristic(
                  Characteristic.ActiveIdentifier
                ).value;
                this.log.debug(
                  'INFO - current Activity to launch - ' + activityToLaunch
                );
                if (!activityToLaunch) {
                  activityToLaunch = this.mainActivityId;
                }
                this.sendInputCommand(
                  homebridgeAccessory,
                  '' + activityToLaunch
                );
              }
              callback(null);
            });
          }
        }.bind(this)
      );

      characteristic.on(
        'get',
        function(callback) {
          this.log.debug('INFO - GET Characteristic.Active');
          homebridgeAccessory.platform.refreshCharacteristic(
            characteristic,
            callback
          );
        }.bind(this)
      );
    } else if (characteristic instanceof Characteristic.ActiveIdentifier) {
      //set the current Activity
      characteristic.on(
        'set',
        function(value, callback) {
          this.log.debug('INFO - SET Characteristic.ActiveIdentifier ' + value);
          this.sendInputCommand(homebridgeAccessory, '' + value);
          callback(null);
        }.bind(this)
      );
      characteristic.on(
        'get',
        function(callback) {
          this.log.debug('INFO - GET Characteristic.ActiveIdentifier');
          homebridgeAccessory.platform.refreshCharacteristic(
            characteristic,
            callback
          );
        }.bind(this)
      );
    } else if (characteristic instanceof Characteristic.RemoteKey) {
      characteristic.on(
        'set',
        function(newValue, callback) {
          this.refreshCurrentActivity(() => {
            this.log.debug(
              'INFO - SET Characteristic.RemoteKey : ' +
                newValue +
                ' with currentActivity ' +
                this._currentActivity
            );

            if (this._currentActivity > 0) {
              switch (true) {
                case newValue === Characteristic.RemoteKey.ARROW_UP:
                  this.log.debug(
                    'INFO - sending DirectionUpCommand for ARROW_UP'
                  );
                  this.sendCommand(
                    this._currentInputService.DirectionUpCommand
                  );
                  break;
                case newValue === Characteristic.RemoteKey.ARROW_DOWN:
                  this.log.debug(
                    'INFO - sending DirectionDownCommand for ARROW_DOWN'
                  );
                  this.sendCommand(
                    this._currentInputService.DirectionDownCommand
                  );
                  break;
                case newValue === Characteristic.RemoteKey.ARROW_LEFT:
                  this.log.debug(
                    'INFO - sending DirectionLeftCommand for ARROW_LEFT'
                  );
                  this.sendCommand(
                    this._currentInputService.DirectionLeftCommand
                  );
                  break;
                case newValue === Characteristic.RemoteKey.ARROW_RIGHT:
                  this.log.debug(
                    'INFO - sending DirectionRightCommand for ARROW_RIGHT'
                  );
                  this.sendCommand(
                    this._currentInputService.DirectionRightCommand
                  );
                  break;
                case newValue === Characteristic.RemoteKey.SELECT:
                  this.log.debug('INFO - sending SelectCommand for SELECT');
                  this.sendCommand(this._currentInputService.SelectCommand);
                  break;
                case newValue === Characteristic.RemoteKey.PLAY_PAUSE:
                  this.log.debug('INFO - sending PlayCommand for PLAY_PAUSE');
                  this.sendCommand(this._currentInputService.PlayCommand);
                  break;
                case newValue === Characteristic.RemoteKey.INFORMATION:
                  this.log.debug('INFO - sending MenuCommand for INFORMATION');
                  this.sendCommand(this._currentInputService.MenuCommand);
                  break;
                case newValue === Characteristic.RemoteKey.BACK:
                  this.log.debug('INFO - sending ReturnCommand for BACK');
                  this.sendCommand(this._currentInputService.ReturnCommand);
                  break;
                case newValue === Characteristic.RemoteKey.EXIT:
                  this.log.debug('INFO - sending HomeCommand for EXIT');
                  this.sendCommand(this._currentInputService.HomeCommand);
                  break;
                case newValue === Characteristic.RemoteKey.REWIND:
                  this.log.debug('INFO - sending RewindCommand for REWIND');
                  this.sendCommand(this._currentInputService.RewindCommand);
                  break;
                case newValue === Characteristic.RemoteKey.FAST_FORWARD:
                  this.log.debug(
                    'INFO - sending FastForwardCommand for FAST_FORWARD'
                  );
                  this.sendCommand(
                    this._currentInputService.FastForwardCommand
                  );
                  break;
                case newValue === Characteristic.RemoteKey.NEXT_TRACK:
                  this.log.debug(
                    'INFO - sending SkipForwardCommand for NEXT_TRACK'
                  );
                  this.sendCommand(
                    this._currentInputService.SkipForwardCommand
                  );
                  break;
                case newValue === Characteristic.RemoteKey.PREVIOUS_TRACK:
                  this.log.debug(
                    'INFO - sending SkipBackwardCommand for PREVIOUS_TRACK'
                  );
                  this.sendCommand(
                    this._currentInputService.SkipBackwardCommand
                  );
                  break;
              }
            }
            callback(null);
          });
        }.bind(this)
      );
    } else if (characteristic instanceof Characteristic.Mute) {
      characteristic.on(
        'set',
        function(value, callback) {
          if (this._currentActivity > 0) {
            this.log('INFO - SET Characteristic.Mute : ' + value);
            this.sendCommand(this._currentInputService.MuteCommand);
          }
          callback(null);
        }.bind(this)
      );

      characteristic.on(
        'get',
        function(callback) {
          this.log('INFO - GET Characteristic.Mute');
          callback(null, false);
        }.bind(this)
      );
    } else if (characteristic instanceof Characteristic.VolumeSelector) {
      characteristic.on(
        'set',
        function(value, callback) {
          if (this._currentActivity > 0) {
            this.log('INFO - SET Characteristic.VolumeSelector : ' + value);
            if (value === Characteristic.VolumeSelector.DECREMENT) {
              this.sendCommand(this._currentInputService.VolumeDownCommand);
            } else {
              this.sendCommand(this._currentInputService.VolumeUpCommand);
            }
          }
          callback(null);
        }.bind(this)
      );
    }
  },

  getInformationService: function(homebridgeAccessory) {
    let informationService = new Service.AccessoryInformation();
    informationService
      .setCharacteristic(Characteristic.Name, homebridgeAccessory.name)
      .setCharacteristic(
        Characteristic.Manufacturer,
        homebridgeAccessory.manufacturer
      )
      .setCharacteristic(Characteristic.Model, homebridgeAccessory.model)
      .setCharacteristic(
        Characteristic.SerialNumber,
        homebridgeAccessory.serialNumber
      );
    return informationService;
  },

  getServices: function(homebridgeAccessory) {
    let services = [];
    let informationService = homebridgeAccessory.platform.getInformationService(
      homebridgeAccessory
    );
    services.push(informationService);
    for (let s = 0; s < homebridgeAccessory.services.length; s++) {
      let service = homebridgeAccessory.services[s];
      for (let i = 0; i < service.characteristics.length; i++) {
        let characteristic = service.controlService.getCharacteristic(
          service.characteristics[i]
        );
        if (characteristic == undefined)
          characteristic = service.controlService.addCharacteristic(
            service.characteristics[i]
          );
        homebridgeAccessory.platform.bindCharacteristicEvents(
          characteristic,
          service,
          homebridgeAccessory
        );
      }
      services.push(service.controlService);
    }
    return services;
  },
};

function HarmonyAccessory(services) {
  this.services = services;
}
