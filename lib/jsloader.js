var fs = require('fs'),
    path = require('path'),
    util = require('util'),
    uglify = require('uglify-js');

var JSLoader = function(srcDirs, opt) {
    if (srcDirs.length == 0) {
        throw new Error('no source directories provided');
    }
    this.setSourceDirectories(srcDirs);
    this.initOptions();
    this.setOptions(opt);
    this.cache = {};
    this.cacheFileDependencies = {};
};

JSLoader.prototype.setSourceDirectories = function(srcDirs) {
    srcDirs = srcDirs.slice(0);
    for (var i = 0; i < srcDirs.length; i++) {
        if (/\/$/.test(srcDirs[i])) {
            srcDirs[i] = srcDirs[i].substring(0, srcDirs[i].length - 1);
        }
    }
    this.srcDirs = srcDirs;
};

JSLoader.prototype.initOptions = function() {
    this.opt = {
        debug: false
    };
};

JSLoader.prototype.setOptions = function(opt) {
    opt = opt || {};
    for (var key in opt) {
        this.opt[key] = opt[key];
    }
};

JSLoader.prototype.getContent = function(files, callback, minify) {
    var self = this,
        content;

    if (typeof(minify) === 'undefined') minify = false;
    if (files.length == 0) return callback(null, '');

    if (content = this.getFromCache(files, minify)) return callback(null, content);

    this.readFilesWithDependencies(files, function(err, fileDataList, fileDataMap) {
        if (err) return callback(err);
        content = self.getFileContentInOrderByDependencies(fileDataList, fileDataMap);
        if (minify) content = self.minifyContent(content);
        callback(null, content);
        self.saveToCache(files, minify, content, fileDataList);
    });
};

JSLoader.prototype.readFilesWithDependencies = function(files, callback) {
    var self = this,
        fileDataList = [], //need to guarantee order
        fileDataMap = {}; //also need fast lookup, so we will use these side-by-side

    var readFileWithDependencies = function(fileIdx) {
        var file = files[fileIdx];

        if (self.opt.debug) {
            util.print("Reading files with dependencies. fileIdx: " + fileIdx + "\n");
        }

        //don't repeat files we've already processed
        if (fileDataMap[file]) {
            if (fileIdx < files.length - 1) {
                readFileWithDependencies(fileIdx + 1);
                return;
            } else {
                if (self.opt.debug) {
                    util.print("Calling callback after reading files with dependencies (upper call)\n");
                }
                callback(null, fileDataList, fileDataMap);
                return;
            }
        }

        self.findFile(file, function(err, filePath) {
            var fileData;

            if (err) return callback(err);

            fs.readFile(filePath, 'utf8', function(err, data) {
                
                fileData = self.parseFileData(data);
                fileData.file = file;
                fileData.filePath = filePath;
                fileDataMap[file] = fileData;
                fileDataList.push(fileData);

                //add dependencies to file list
                files = files.concat(fileData.dependencies);

                if (fileIdx < files.length - 1) {
                    readFileWithDependencies(fileIdx + 1);
                    return;
                } else {
                    if (self.opt.debug) {
                        util.print("Calling callback after reading files with dependencies (lower call)\n");
                    }
                    callback(null, fileDataList, fileDataMap);
                    return;
                }
            });
        });
    };
    readFileWithDependencies(0);
};

JSLoader.prototype.buildCacheKey = function(files, minify) {
    return files.join(',') + (minify ? '|min' : '');
};

JSLoader.prototype.getFromCache = function(files, minify) {
    var cacheKey = this.buildCacheKey(files, minify);
    return this.cache[cacheKey];
};

JSLoader.prototype.saveToCache = function(files, minify, content, fileDataList) {
    var self = this,
        cacheKey = this.buildCacheKey(files, minify);
    this.cache[cacheKey] = content;
    for (i = 0; i < fileDataList.length; i++) {
        if (!self.cacheFileDependencies[fileDataList[i].filePath]) {
            self.cacheFileDependencies[fileDataList[i].filePath] = [];
            (function(filePath) {
                fs.watchFile(filePath, function(curr, prev) {
                    var cacheKey = self.cacheFileDependencies[filePath];
                    delete self.cache[cacheKey];
                });
            })(fileDataList[i].filePath);
        }
        self.cacheFileDependencies[fileDataList[i].filePath].push(cacheKey);
    }
};

JSLoader.prototype.parseFileData = function(data) {
    var dependencies = [],
        content = '',
        foundNonRequireLine = false,
        i, line, lines;
    //TODO: don't assume unix style line separator
    lines = data.split("\n");
    for (i = 0; i < lines.length; i++) {
        line = lines[i];
        if (!foundNonRequireLine && this.isRequireLine(line)) {
            dependencies.push(this.extractDependency(line));
        } else {
            foundNonRequireLine = true;
            if (line.length > 0) content += line + "\n";
        }
    }
    return {
        dependencies: dependencies,
        content: content
    };
};

JSLoader.prototype.isRequireLine = function(line) {
    return /^\/\/require/.test(line);
};

JSLoader.prototype.extractDependency = function(line) {
    return line.match(/^\/\/require (.*)$/)[1];
};

JSLoader.prototype.getFileContentInOrderByDependencies = function(fileDataList, fileDataMap) {
    var content = '',
        fileDataList = fileDataList.slice(0),
        fileData;
    while (fileDataList.length > 0) {
        fileData = this.removeNextFileData(fileDataList);
        //content += '// File: ' + fileData.file + "\n";
        content += fileData.content;
    }
    return content;
};

JSLoader.prototype.removeNextFileData = function(fileDataList) {
    var i, fileData;
    for (i = 0; i < fileDataList.length; i++) {
        if (fileDataList[i].dependencies.length == 0) {
            fileData = fileDataList.splice(i, 1)[0];
            this.removeFromAllDependencies(fileDataList, fileData.file);
            return fileData;
        }
    }
    throw new Error('Unable to resolve dependencies. You probably have a circular dependency or a dependency on a file that is unavailable.');
};

JSLoader.prototype.removeFromAllDependencies = function(fileDataList, file) {
    var i, c, dependencies;
    for (i = 0; i < fileDataList.length; i++) {
        dependencies = fileDataList[i].dependencies;
        for (c = 0; c < dependencies.length; c++) {
            if (dependencies[c] == file) {
                dependencies.splice(c, 1);
            }
        }
    }
};

JSLoader.prototype.findFile = function(file, callback) {
    var self = this,
        checkFileFunc;
    
    checkFileFunc = function(i) {
        var filePath = self.srcDirs[i] + '/' + file;
        path.exists(filePath, function(exists) {
            if (exists) {
                callback(null, filePath);
            } else if (++i < self.srcDirs.length) {
                checkFileFunc(i);
            } else {
                callback('cannot find file "' + file + '"');
            }
        });
    }
    checkFileFunc(0);
};

JSLoader.prototype.minifyContent = function(content) {
    content = uglify.parser.parse(content);
    content = uglify.uglify.ast_mangle(content);
    content = uglify.uglify.ast_squeeze(content);
    content = uglify.uglify.gen_code(content);
    return content;
};

module.exports.JSLoader = JSLoader;