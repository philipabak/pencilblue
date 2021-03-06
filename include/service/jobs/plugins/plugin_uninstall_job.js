/*
    Copyright (C) 2015  PencilBlue, LLC

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

//dependencies
var process = require('process');
var domain  = require('domain');
var util    = require('../../../util.js');

module.exports = function PluginUninstallJobModule(pb) {

    /**
     * A system job that coordinates the uninstall of a plugin across the cluster.
     * The job has two modes.  The first is initiator.  This is the process that
     * receives the request to uninstall the plugin.  It coordinates a sequenced
     * uninstall from each process in the cluster.  The initiator does this by
     * getting a list of active processes through the service registry.  It then
     * uses the registry to send a message to each process to uninstall the plugin.
     * Some operations are repeated for each server but this is ok based on the
     * current set of operations.  When a command is received that instructs a
     * process to uninstall a plugin it creates an instance of the plugin uninstall
     * job with isInitiator = FALSE.  This changes causes the actual uninstall
     * process to take place.  Log statements are sent both to the system logger
     * and to the job log persistence entity.
     * @class PluginUninstallJob
     * @constructor
     * @extends PluginJobRunner
     */
    function PluginUninstallJob(){
        PluginUninstallJob.super_.call(this);

        //initialize
        this.setParallelLimit(1);
    };
    util.inherits(PluginUninstallJob, pb.PluginJobRunner);

    /**
     * The command to that intends for the the uninstall job to run
     * @static
     * @readonly
     * @property UNINSTALL_PLUGIN_COMMAND
     * @type {String}
     */
    PluginUninstallJob.UNINSTALL_PLUGIN_COMMAND = 'uninstall_plugin';

    /**
     * Retrieves the tasks needed to contact each process in the cluster to
     * uninstall the plugin.
     * @method getInitiatorTasks
     * @param {Function} cb A callback that takes two parameters: cb(Error, Object|Array)
     */
    PluginUninstallJob.prototype.getInitiatorTasks = function(cb) {
        var self = this;

        var command = {
            pluginUid: self.getPluginUid(),
            jobId: self.getId(),

            //we provide a progress function to update the job listing
            progress: function(indexOfExecutingTask, totalTasks) {

                var increment = indexOfExecutingTask > 0 ? 100 / totalTasks / self.getChunkOfWorkPercentage(): 0;
                self.onUpdate(increment);
            }
        };
        var tasks = [
            this.createCommandTask(PluginUninstallJob.UNINSTALL_PLUGIN_COMMAND, command)
        ];
        cb(null, tasks);
    };

    /**
     * Retrieves the tasks needed to uninstall the plugin from this executing
     * process.  The tasks are executed in series:
     * <ol>
     * <li>Call the plugin's onUninstall function</li>
     * <li>Unregister any routes and controllers</li>
     * <li>Remove any plugin settings</li>
     * <li>Remove any theme settings</li>
     * <li>Remove the plugin record from persistence</li>
     * <li>Switch active theme if needed</li>
     * <li>Deactivate the plugin from this process</li>
     * </ol>
     * @method getWorkerTasks
     * @param {Function} cb A callback that takes two parameters: cb(Error, Object|Array)
     */
    PluginUninstallJob.prototype.getWorkerTasks = function(cb) {
        var self = this;

        var pluginUid = this.getPluginUid();
        var tasks = [

            //call onUninstall
            function(callback) {
                if (!pb.PluginService.isActivePlugin(pluginUid)) {
                    self.log("Skipping call to plugin's onUninstall function.  Main module was not active.");
                    callback(null, true);
                    return;
                }

                var mm = pb.PluginService.getActiveMainModule(pluginUid);
                if (util.isFunction(mm.onUninstall)) {
                    self.log('Calling plugin onUnstall', pluginUid);

                    var d = domain.create();
                    d.on('error', callback);
                    d.run(function() {
                        mm.onUninstall(callback);
                    });
                }
                else {
                    self.log('Plugin onUninstall function does not exist.  Skipping.');
                    callback(null, true);
                }
            },

            //unregister routes
            function(callback) {
                var routesRemoved = pb.RequestHandler.unregisterThemeRoutes(pluginUid);
                self.log('Unregistered %d routes', routesRemoved);
                process.nextTick(function(){callback(null, true);});
            },

            //remove localization
            function(callback) {
                //TODO refactor localization to figure out how to remove only those
                //that were overriden. For now any overriden localizations will be
                //left until the server cycles.  This is not ideal but will suffice
                //for most use cases.  The only affected use case is if a default
                //label is overriden.
                process.nextTick(function(){callback(null, true);});
            },

            //remove settings
            function(callback) {
                self.log('Attemping to remove plugin settings');

                pb.plugins.pluginSettingsService.purge(pluginUid, function (err, result) {
                    callback(err, !util.isError(err));
                });
            },

            //remove theme settings
            function(callback) {
                self.log('Attemping to remove theme settings');

                pb.plugins.themeSettingsService.purge(pluginUid, function (err, result) {
                    callback(err, !util.isError(err));
                });
            },

            //remove plugin record from "plugin" collection
            function(callback) {
                self.log('Attemping to remove plugin from persistent storage');

                var where = {
                    uid: pluginUid
                };
                var dao = new pb.DAO();
                dao.delete(where, 'plugin', function(err, result) {
                    callback(err, !util.isError(err));
                });
            },

            //roll over to default theme
            function(callback) {
                self.log('Inspecting the active theme');

                //retrieve the plugin so we can see if the value matches what we
                //are uninstalling
                pb.settings.get('active_theme', function(err, activeTheme) {
                    if (util.isError(err)) {
                        return callback(err, false);
                    }

                    //check if we need to reset the active theme
                    if (activeTheme === pluginUid) {
                        self.log('Uninstalling the active theme.  Switching to pencilblue');

                        pb.settings.set('active_theme', 'pencilblue', function(err, result) {
                            callback(err, result ? true : false);
                        });
                    }
                    else {
                        callback(null, true);
                    }
                });
            },

            //remove from ACTIVE_PLUGINS//unregister services
            function(callback) {
                var result = pb.PluginService.deactivatePlugin(pluginUid);
                process.nextTick(function(){callback(null, result);});
            }
        ];
        cb(null, tasks);
    };

    /**
     * Called when the tasks have completed execution and isInitiator = FALSE. The
     * function blindly passes the results of the tasks back to the callback.
     * @param {Error} err The error that occurred (if any) during task execution
     * @param {Array} results An array containing the result of each executed task
     * @param {Function} cb A callback that provides two parameters: The first is
     * any error that occurred (if exists) and the second is an array of Boolean
     * values that indicate the success or failure of each task.
     */
    PluginUninstallJob.prototype.processWorkerResults = function(err, results, cb) {
        cb(err, results);
    };

    //exports
    return PluginUninstallJob;
};
