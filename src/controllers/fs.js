'use strict';

/**
 * Pterodactyl - Daemon
 * Copyright (c) 2015 - 2017 Dane Everitt <dane@daneeveritt.com>.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
const Fs = require('fs-extra');
const Async = require('async');
const Path = require('path');
const Chokidar = require('chokidar');
const _ = require('lodash');
const Mmm = require('mmmagic');
const RandomString = require('randomstring');
const Process = require('child_process');
const Util = require('util');

const Magic = Mmm.Magic;
const Mime = new Magic(Mmm.MAGIC_MIME_TYPE);

class FileSystem {
    constructor(server) {
        this.server = server;

        const Watcher = Chokidar.watch(this.server.configLocation, {
            persistent: true,
            awaitWriteFinish: false,
        });

        Watcher.on('change', () => {
            if (this.server.knownWrite !== true) {
                this.server.log.debug('Detected remote file change, updating JSON object correspondingly.');
                Fs.readJson(this.server.configLocation, (err, object) => {
                    if (err) {
                        // Try to overwrite those changes with the old config.
                        this.server.log.warn(err, 'An error was detected with the changed file, attempting to undo the changes.');
                        this.server.knownWrite = true;
                        Fs.writeJson(this.server.configLocation, this.server.json, {spaces: 2}, writeErr => {
                            if (!writeErr) {
                                this.server.log.debug('Successfully undid those remote changes.');
                            } else {
                                this.server.log.fatal(writeErr, 'Unable to undo those changes, this could break the daemon badly.');
                            }
                        });
                    } else {
                        this.server.json = object;
                    }
                });
            }
            this.server.knownWrite = false;
        });
    }

    size(next) {
        const Exec = Process.spawn('du', ['-hsb', this.server.path()], {});

        Exec.stdout.on('data', data => {
            next(null, parseInt(_.split(data.toString(), '\t')[0], 10));
        });

        Exec.on('error', execErr => {
            this.server.log.error(execErr);
            return next(new Error('There was an error while attempting to check the size of the server data folder.'));
        });

        Exec.on('exit', (code, signal) => {
            if (code !== 0) {
                return next(new Error(`Unable to determine size of server data folder, exited with code ${code} signal ${signal}.`));
            }
        });
    }

    chown(file, next) {
        let chownTarget = file;
        if (!_.startsWith(chownTarget, this.server.path())) {
            chownTarget = this.server.path(file);
        }

        const Exec = Process.spawn('chown', ['-R', Util.format('%d:%d', this.server.json.build.user, this.server.json.build.user), chownTarget], {});
        Exec.on('error', execErr => {
            this.server.log.error(execErr);
            return next(new Error('There was an error while attempting to set ownership of files.'));
        });
        Exec.on('exit', (code, signal) => {
            if (code !== 0) {
                return next(new Error(`Unable to set ownership of files properly, exited with code ${code} signal ${signal}.`));
            }
            return next();
        });
        
        
    }

    isSelf(moveTo, moveFrom) {
        const target = this.server.path(moveTo);
        const source = this.server.path(moveFrom);

        if (!_.startsWith(target, source)) {
            return false;
        }

        const end = target.slice(source.length);
        if (!end) {
            return true;
        }

        return _.startsWith(end, '/');
    }

    write(file, data, next) {
        Async.series([
            callback => {
                this.server.knownWrite = true;
                callback();
            },
            callback => {
                Fs.outputFile(this.server.path(file), data, callback);
            },
            callback => {
                this.chown(file, callback);
            },
        ], next);
    }

    read(file, next) {
        Fs.stat(this.server.path(file), (err, stat) => {
            if (err)
                return next(err);
            if (!stat.isFile()) {
                return next(new Error('The file requested does not appear to be a file.'));
            }
            if (stat.size > 10000000) {
                return next(new Error('This file is too large to open.'));
            }
            Fs.readFile(this.server.path(file), 'utf8', next);
        });
    }

    readEnd(file, bytes, next) {
        if (_.isFunction(bytes)) {
            next = bytes; // eslint-disable-line
            bytes = 80000; // eslint-disable-line
        }
        Fs.stat(this.server.path(file), (err, stat) => {
            if (err)
                return next(err);
            if (!stat.isFile()) {
                return next(new Error('The file requested does not appear to be a file.'));
            }
            let opts = {};
            let lines = '';
            if (stat.size > bytes) {
                opts = {
                    start: (stat.size - bytes),
                    end: stat.size,
                };
            }
            const stream = Fs.createReadStream(this.server.path(file), opts);
            stream.on('data', data => {
                lines += data;
            });
            stream.on('end', () => {
                next(null, lines);
            });
        });
    }

    mkdir(path, next) {
        if (!_.isArray(path)) {
            Fs.ensureDir(this.server.path(path), err => {
                if (err)
                    return next(err);
                this.chown(path, next);
            });
        } else {
            Async.eachOfLimit(path, 5, (value, key, callback) => {
                Fs.ensureDir(this.server.path(value), err => {
                    if (err)
                        return callback(err);
                    this.chown(value, callback);
                });
            }, next);
        }
    }

    rm(path, next) {
        if (_.isString(path)) {
            // Safety - prevent deleting the main folder.
            if (Path.resolve(this.server.path(path)) === this.server.path()) {
                return next(new Error('You cannot delete your home folder.'));
            }

            Fs.remove(this.server.path(path), next);
        } else {
            Async.eachOfLimit(path, 5, (value, key, callback) => {
                // Safety - prevent deleting the main folder.
                if (Path.resolve(this.server.path(value)) === this.server.path()) {
                    return next(new Error('You cannot delete your home folder.'));
                }

                Fs.remove(this.server.path(value), callback);
            }, next);
        }
    }
    cleardirectory(path, next) {
        console.log(Path.resolve(this.server.path(path)));
        if (_.isString(path)) {
            // Safety - prevent deleting the main folder.
            if (Path.resolve(this.server.path(path)) === this.server.path()) {
                return next(new Error('You cannot delete your home folder.'));
            }
            const Exec = Process.spawn('rm', ['-rf', '*', this.server.path()]);
            Exec.on('error', execErr => {
                console.log(execErr);
                this.server.log.error(execErr);
                return next(new Error('Erreur pendant la suppression des backups'));
            });
            Exec.on('exit', (code, signal) => {
                if (code !== 0) {
                    console.log(code);
                    return next(new Error(`Erreur pendant la suppression des backups code ${code} signal ${signal}.`));
                }
                return next(null);
                //console.log(code);
            });
            Exec.stdout.on('data', (data) => {
                console.log(`stdout: ${data}`);
            });

            Exec.stderr.on('data', (data) => {
                console.log(`stderr: ${data}`);
            });
        }

    }

    copy(initial, ending, opts, next) {
        if (_.isFunction(opts)) {
            next = opts; // eslint-disable-line
            opts = {}; // eslint-disable-line
        }

        if (!_.isArray(initial) && !_.isArray(ending)) {
            if (this.isSelf(ending, initial)) {
                return next(new Error('You cannot copy a folder into itself.'));
            }
            Async.series([
                callback => {
                    Fs.copy(this.server.path(initial), this.server.path(ending), {
                        overwrite: opts.overwrite || true,
                        preserveTimestamps: opts.timestamps || false,
                    }, callback);
                },
                callback => {
                    this.chown(ending, callback);
                },
            ], next);
        } else if (!_.isArray(initial) || !_.isArray(ending)) {
            return next(new Error('Values passed to copy function must be of the same type (string, string) or (array, array).'));
        } else {
            Async.eachOfLimit(initial, 5, (value, key, callback) => {
                if (_.isUndefined(ending[key])) {
                    return callback(new Error('The number of starting values does not match the number of ending values.'));
                }

                if (this.isSelf(ending[key], value)) {
                    return next(new Error('You cannot copy a folder into itself.'));
                }
                Fs.copy(this.server.path(value), this.server.path(ending[key]), {
                    overwrite: _.get(opts, 'overwrite', true),
                    preserveTimestamps: _.get(opts, 'timestamps', false),
                }, err => {
                    if (err)
                        return callback(err);
                    this.chown(ending[key], callback);
                });
            }, next);
        }
    }

    stat(file, next) {
        Fs.stat(this.server.path(file), (err, stat) => {
            if (err)
                next(err);
            Mime.detectFile(this.server.path(file), (mimeErr, result) => {
                next(null, {
                    'name': (Path.parse(this.server.path(file))).base,
                    'created': stat.ctime,
                    'modified': stat.mtime,
                    'size': stat.size,
                    'directory': stat.isDirectory(),
                    'file': stat.isFile(),
                    'symlink': stat.isSymbolicLink(),
                    'mime': result || 'unknown',
                });
            });
        });
    }

    move(initial, ending, next) {
        if (!_.isArray(initial) && !_.isArray(ending)) {
            if (this.isSelf(ending, initial)) {
                return next(new Error('You cannot move a file or folder into itself.'));
            }
            Fs.move(this.server.path(initial), this.server.path(ending), {overwrite: false}, err => {
                if (err && !_.startsWith(err.message, 'EEXIST:'))
                    return next(err);
                this.chown(ending, next);
            });
        } else if (!_.isArray(initial) || !_.isArray(ending)) {
            return next(new Error('Values passed to move function must be of the same type (string, string) or (array, array).'));
        } else {
            Async.eachOfLimit(initial, 5, (value, key, callback) => {
                if (_.isUndefined(ending[key])) {
                    return callback(new Error('The number of starting values does not match the number of ending values.'));
                }

                if (this.isSelf(ending[key], value)) {
                    return next(new Error('You cannot move a file or folder into itself.'));
                }
                Fs.move(this.server.path(value), this.server.path(ending[key]), {overwrite: false}, err => {
                    if (err && !_.startsWith(err.message, 'EEXIST:'))
                        return callback(err);
                    this.chown(ending[key], callback);
                });
            }, next);
        }
    }

    decompress(files, next) {
        if (!_.isArray(files)) {
            const fromFile = this.server.path(files);
            const toDir = fromFile.substring(0, _.lastIndexOf(fromFile, '/'));
            this.systemDecompress(fromFile, toDir, next);
        } else if (_.isArray(files)) {
            Async.eachLimit(files, 1, (file, callback) => {
                const fromFile = this.server.path(file);
                const toDir = fromFile.substring(0, _.lastIndexOf(fromFile, '/'));
                this.systemDecompress(fromFile, toDir, callback);
            }, next);
        } else {
            return next(new Error('Invalid datatype passed to decompression function.'));
        }
    }

    systemDecompress(file, to, next) {
        Mime.detectFile(file, (err, result) => {
            if (err)
                return next(err);

            let Exec;
            if (result === 'application/x-gzip' || result === 'application/gzip') {
                Exec = Process.spawn('tar', ['xzf', Path.basename(file), '-C', to], {
                    cwd: Path.dirname(file),
                    uid: this.server.json.build.user,
                    gid: this.server.json.build.user,
                });
            } else if (result === 'application/zip') {
                Exec = Process.spawn('unzip', ['-q', '-o', Path.basename(file), '-d', to], {
                    cwd: Path.dirname(file),
                    uid: this.server.json.build.user,
                    gid: this.server.json.build.user,
                });
            } else {
                return next(new Error(`Decompression of file failed: ${result} is not a decompessible Mimetype.`));
            }

            Exec.on('error', execErr => {
                this.server.log.error(execErr);
                return next(new Error('There was an error while attempting to decompress this file.'));
            });
            Exec.on('exit', (code, signal) => {
                if (code !== 0) {
                    return next(new Error(`Decompression of file exited with code ${code} signal ${signal}.`));
                }

                return next();
            });
        });
    }

    // Unlike other functions, if multiple files and folders are passed
    // they will all be combined into a single archive.
    compress(files, to, next) {
        if (!_.isString(to)) {
            return next(new Error('The to field must be a string for the folder in which the file should be saved.'));
        }

        const SaveAsName = `ptdlfm.${RandomString.generate(8)}.tar`;
        if (!_.isArray(files)) {
            if (this.isSelf(to, files)) {
                return next(new Error('Unable to compress folder into itself.'));
            }
            this.systemCompress([_.replace(this.server.path(files), `${this.server.path()}/`, '')], Path.join(this.server.path(to), SaveAsName), next);
        } else if (_.isArray(files)) {
            const FileEntries = [];
            Async.series([
                callback => {
                    Async.eachLimit(files, 5, (file, eachCallback) => {
                        // If it is going to be inside itself, skip and move on.
                        if (this.isSelf(to, file)) {
                            return eachCallback();
                        }

                        FileEntries.push(_.replace(this.server.path(file), `${this.server.path()}/`, ''));
                        eachCallback();
                    }, callback);
                },
                callback => {
                    if (_.isEmpty(FileEntries)) {
                        return next(new Error('None of the files passed to the command were valid.'));
                    }
                    this.systemCompress(FileEntries, Path.join(this.server.path(to), SaveAsName), callback);
                },
            ], err => {
                next(err, SaveAsName);
            });
        } else {
            return next(new Error('Invalid datatype passed to decompression function.'));
        }
    }

    systemCompress(files, archive, next) {
        const Exec = Process.spawn('tar', ['czf', archive, files.join(' ')], {
            cwd: this.server.path(),
            uid: this.server.json.build.user,
            gid: this.server.json.build.user,
        });

        Exec.on('error', execErr => {
            this.server.log.error(execErr);
            return next(new Error('There was an error while attempting to compress this folder.'));
        });
        Exec.on('exit', (code, signal) => {
            if (code !== 0) {
                return next(new Error(`Compression of files exited with code ${code} signal ${signal}.`));
            }

            return next(null, Path.basename(archive));
        });
    }

    directory(path, next) {
        const responseFiles = [];
        Async.waterfall([
            callback => {
                Fs.stat(this.server.path(path), (err, s) => {
                    if (err)
                        return callback(err);
                    if (!s.isDirectory()) {
                        return callback(new Error('The path requested is not a valid directory on the system.'));
                    }
                    return callback();
                });
            },
            callback => {
                Fs.readdir(this.server.path(path), callback);
            },
            (files, callback) => {
                Async.each(files, (item, eachCallback) => {
                    Async.auto({
                        do_stat: aCallback => {
                            Fs.stat(Path.join(this.server.path(path), item), (statErr, stat) => {
                                aCallback(statErr, stat);
                            });
                        },
                        do_mime: aCallback => {
                            Mime.detectFile(Path.join(this.server.path(path), item), (mimeErr, result) => {
                                aCallback(mimeErr, result);
                            });
                        },
                        do_push: ['do_stat', 'do_mime', (results, aCallback) => {
                                responseFiles.push({
                                    'name': item,
                                    'created': results.do_stat.birthtime,
                                    'modified': results.do_stat.mtime,
                                    'size': results.do_stat.size,
                                    'directory': results.do_stat.isDirectory(),
                                    'file': results.do_stat.isFile(),
                                    'symlink': results.do_stat.isSymbolicLink(),
                                    'mime': results.do_mime || 'unknown',
                                });
                                aCallback();
                            }],
                    }, eachCallback);
                }, callback);
            },
        ], err => {
            next(err, _.sortBy(responseFiles, [(o) => {
                    return _.lowerCase(o.name);
                }, 'created'])); // eslint-disable-line
        });
    }

    backup(name, ecrase, next) {
        const pathServer = this.server.path(".");
        const SaveAsName = name + `.zip`;

        Fs.stat(this.server.json.pathbackup, (err) => {
            if (err) {
                Fs.ensureDir(this.server.json.pathbackup, err => {

                    if (err) {
                        return next(err);
                    } else {
                        const Exec = Process.spawn('chown', [Util.format('%d:%d', this.server.json.build.user, this.server.json.build.user), this.server.json.pathbackup], {});
                        Exec.on('error', execErr => {
                            this.server.log.error(execErr);
                            return next(new Error('There was an error while attempting to set ownership of files.'));
                        });
                        Exec.on('exit', (code, signal) => {
                            if (code !== 0) {
                                return next(new Error(`Unable to set ownership of files properly, exited with code ${code} signal ${signal}.`));
                            }
                            console.log("LOLOLOLOLO");
                            this.systemBackup([_.replace(pathServer, `${this.server.json.pathbackup}/`, '')], Path.join(this.server.json.pathbackup, SaveAsName), next);

                        });

                    }
                });
            } else {
                console.log(ecrase);
                if (ecrase) {
                    console.log('Remove all save');
                    const Exec1 = Process.spawn('chmod', ['775', '-R', this.server.json.pathbackup]
                            , {
                                cwd: this.server.json.pathbackup,
                                uid: this.server.json.build.user,
                                gid: this.server.json.build.user
                            });
                    Exec1.on('error', execErr => {
                        console.log(execErr);
                        this.server.log.error(execErr);
                        return next(new Error('Erreur pendant la suppression des backups'));
                    });
                    Exec1.on('exit', (code, signal) => {
                        if (code !== 0) {
                            console.log(code);
                            return next(new Error(`Erreur pendant la suppression des backups code ${code} signal ${signal}.`));
                        }
                        console.log(code);
                        this.systemBackup([_.replace(pathServer, `${this.server.json.pathbackup}/`, '')], Path.join(this.server.json.pathbackup, SaveAsName), next);


                    });
                    Exec1.stdout.on('data', (data) => {
                        console.log(`stdout: ${data}`);
                    });

                    Exec1.stderr.on('data', (data) => {
                        console.log(`stderr: ${data}`);
                    });
                    Process.exec('rm -rf '+this.server.json.pathbackup+'/*.zip ', (error, stdout, stderr) => {
                        if (error) {
                            console.error(`exec error: ${error}`);
                            return;
                        }
                        console.log(`stdout: ${stdout}`);
                        console.log(`stderr: ${stderr}`);
                    });

                    


                }else{
                    console.log("Pas de supression");
                    this.systemBackup([_.replace(pathServer, `${this.server.json.pathbackup}/`, '')], Path.join(this.server.json.pathbackup, SaveAsName), next);

                }

            }

        });

    }
deleteBackup(files, next) {

        Process.exec('rm -f '+this.server.json.pathbackup+'/'+files+'.zip', (error, stdout, stderr) => {
                        if (error) {
                            console.error(`exec error: ${error}`);
                            return;
                        }
                        return next(null)
                        console.log(`stdout: ${stdout}`);
                        console.log(`stderr: ${stderr}`);
                        return next(null)
                    });
    }
    systemBackup(files, archive, next) {

        console.log(archive);
        const Exec = Process.spawn('zip', ['-r', archive, "."], {
            cwd: this.server.path(),
            uid: this.server.json.build.user,
            gid: this.server.json.build.user,
            detached: true,
            stdio: 'ignore'

        });
        Exec.unref();
        Exec.on('error', execErr => {
            console.log("Start backup111111");
            this.server.log.error(execErr);
            return next(new Error('There was an error while attempting to compress this folder.'));
        });
        Exec.on('exit', (code, signal) => {
            if (code !== 0) {
                console.log(code);
                return next(new Error(`Compression of files exited with code ${code} signal ${signal}.`));
            }

            return next(null, Path.basename(archive));
        });
    }
    
    ClearDataServer(next) {
        console.log("Vider le répertoire server");
        Process.exec('rm -rf '+this.server.path()+'/* ', (error, stdout, stderr) => {
                        if (error) {
                            console.error(`exec error: ${error}`);
                            return next(new Error(`Compression of files exited with code ${error}.`));
                        }
                        console.log(`stdout: ${stdout}`);
                        console.log(`stderr: ${stderr}`);
                        return next(null);
                    });
    }
    RestorDataServer(archive,next) {
        console.log("Restauration du serveur");
        Process.exec('unzip '+this.server.json.pathbackup+'/'+archive+'.zip -d '+this.server.path()+'/ ' , (error, stdout, stderr) => {
                        if (error) {
                            console.error(`exec error: ${error}`);
                            return next(new Error(`Compression of files exited with code ${error}.`));
                        }
                        console.log(`stderr: ${stderr}`);
                        this.chown(this.server.path(), next);
                        
                    });
    }
}

module.exports = FileSystem;
