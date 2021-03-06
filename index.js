var debug = require('debug')('loopback-ds-changed-mixin');
var utils = require('loopback-datasource-juggler/lib/utils');
var _ = require('lodash');

function changed(Model, options) {
  'use strict';

  if (typeof Model[options.callback] !== 'function') {
    console.warn('Callback %s is not a model function', options.callback);
  }

  debug('Changed mixin for Model %s', Model.modelName);

  var loopback = require('loopback');

  /**
   * Determine which properties are changed and store them in changedItems
   */
  Model.observe('before save', function(ctx, next) {
    // Do nothing if a new instance if being created.
    if (ctx.instance && ctx.isNewInstance) {
      return next();
    }

    if (!ctx.hookState.changedItems) {
      ctx.hookState.changedItems = [];
    }

    var properties = _.keys(options.properties);

    debug('before save ctx.instance: %o', ctx.instance);
    debug('before save ctx.currentInstance: %o', ctx.currentInstance);
    debug('before save ctx.data: %o', ctx.data);
    debug('before save ctx.where: %o', ctx.where);

    if (ctx.currentInstance) {
      debug('Detected prototype.updateAttributes');
      //if (Model.propertiesChanged(ctx.currentInstance, ctx.data, properties)) {
      //  ctx.hookState.changedItems = [ctx.currentInstance.getId()];
      //}
      ctx.hookState.changedItems = Model.getChangedProperties(ctx.currentInstance, ctx.data, properties);

      //console.log('ctx.hookState.changedItems 1 a: ');
      //console.log(ctx.hookState.changedItems);

      next();
    } else if (ctx.instance) {
      debug('Working with existing instance %o', ctx.instance);
      // Figure out wether this item has changed properties.
      ctx.instance.itemHasChangedProperties(ctx.instance, properties)
        .then(function(changed) {
          ctx.hookState.changedItems = changed;
          next();
        }).catch(next);
    } else {
      debug('anything else: upsert, updateAll');
      // Figure out which items have changed properties.
      Model.itemsWithChangedProperties(ctx.where, ctx.data, properties)
        .then(function(changed) {
          ctx.hookState.changedItems = changed;
          next();
        }).catch(next);
    }
  });

  Model.observe('after save', function(ctx, next) {
    if (ctx.hookState.changedItems && !_.isEmpty(ctx.hookState.changedItems)) {

      var changedItems = ctx.hookState.changedItems;

      debug('after save: changedItems: %o', changedItems);

      var idList = Object.keys(ctx.hookState.changedItems);
      debug('after save: idList: %o', idList);

      Model.find({
        where: {
          id: {
            inq: idList
          }
        },
        fields: [
          Model.getIdName()
        ]
      }).then(function(items) {
        // Extract the ID's from the resultset
        var itemIds = Model.extractChangedItemIds(items);
        debug('after save: itemIds', itemIds);

        // TODO remove changedItems keys that are not in itemIds
        var callbackItems = changedItems;

        debug('after save: callbackItems', callbackItems);

        if (typeof Model[options.callback] !== 'function') return false;
        return Model[options.callback](callbackItems);
      })
      .then(function(res) {
        next();
      }).catch(next);
    } else {
      next();
    }
  });

  /**
   * Searches for items with properties that differ from a specific set.
   *
   * @param {Object} conditions Where clause detailing items to compare.
   * @param {Object} properties Properties to compare with the found instances.
   * @param {Function} cb A Cllback function.
   * @returns {Array} Returns a list of Model instance Ids whose data differ from
   *                  that in the properties argument.
   */
  Model.itemsWithChangedProperties = function(conditions, newVals, properties, cb) {
    debug('itemsWithChangedProperties: Looking for items with changed properties...');
    debug('itemsWithChangedProperties: conditions is: %o', conditions);
    debug('itemsWithChangedProperties: newVals is: %o', newVals);
    debug('itemsWithChangedProperties: properties is 1 : %o', properties);
    cb = cb || utils.createPromiseCallback();

    conditions = conditions || {};
    newVals = typeof newVals.toJSON === 'function' ? newVals.toJSON() : newVals || {};
    properties = properties || {};

    var filterFields = [
      Model.getIdName()
    ];

    // Build up a list of property conditions to include in the query.
    var propertyConditions = {or: []};
    _.forEach(newVals, function(value, key) {
      if (_.includes(properties, key)) {
        var fieldFilter = {};
        fieldFilter[key] = {'neq': value};
        propertyConditions.or.push(fieldFilter);
        filterFields.push(key);
      }
    });

    if (!propertyConditions.or.length) propertyConditions = {};

    debug('itemsWithChangedProperties: propertyConditions 1 : %o', propertyConditions);

    // If there are no property conditions, do nothing.
    if (_.isEmpty(propertyConditions)) {
      process.nextTick(function() {
        cb(null, false);
      });
      return cb.promise;
    }

    // Build the final filter.
    var filter = {
      fields: filterFields,
      where: {
        and: [propertyConditions, conditions]
      }
    };

    debug('itemsWithChangedProperties: propertyConditions 2 : %o', propertyConditions);
    debug('itemsWithChangedProperties: filter Fields %o', filterFields);
    debug('itemsWithChangedProperties: conditions %o', conditions);
    debug('itemsWithChangedProperties: final filter %o', filter);

    Model.find(filter)
      .then(function(results) {

        debug('itemsWithChangedProperties: filter results %o', results);

        var changedProperties = {};

        results.map(function(oldVals) {

          debug('itemsWithChangedProperties: oldVals %o', oldVals);
          debug('itemsWithChangedProperties: newVals %o', newVals);

          //changedProperties[oldVals.id] = {};

          var changed = {};

          properties.map(function(property) {

            debug('itemsWithChangedProperties: Matching property %s', property);

            if (newVals[property] !== undefined) {

              var newVal = newVals[property];

              debug('itemsWithChangedProperties:   - newVal %s : %s : ', property, newVal);

              if (!oldVals[property]) {
                changed[property] = newVal;
                debug('itemsWithChangedProperties:   - no oldVal %s : %s : ', property, newVal);
              } else if (newVal !== oldVals[property]) {
                var oldVal = oldVals[property];
                debug('itemsWithChangedProperties:   - oldVal %s : %s : ', property, newVal);

                changed[property] = newVal;
              }

            }
          });

          debug('itemsWithChangedProperties: changed %o', changed);
          changedProperties[oldVals.id] = changed;

        });

        debug('itemsWithChangedProperties: changedProperties %o', changedProperties);
        cb(null, changedProperties);
      }).catch(cb);

    return cb.promise;
  };

  /**
   * Compare self with data to see if specific properties have been altered.
   *
   * @param {Object} data Target object to compare with.
   * @param {Array} properties List of properties to be chacked.
   * @returns {Boolean} Returns true if the properties have been altered.
   */
  Model.prototype.itemHasChangedProperties = function(data, properties, cb) {
    cb = cb || utils.createPromiseCallback();

    properties = properties || {};

    if (_.isEmpty(properties)) {
      process.nextTick(function() {
        cb(null, false);
      });
      return cb.promise;
    }

    Model.findById(this.getId())
      .then(function(instance) {
        var changedProperties = Model.getChangedProperties(instance, data, properties);
        debug('itemHasChangedProperties: found supposedly changed items: %o', changedProperties);
        cb(null, changedProperties);
      }).catch(cb);

    return cb.promise;
  };

  /**
   * Compare source and target objects to see if specific properties have
   * been altered.
   *
   * @param {Object} source Source object to compare against.
   * @param {Object} target Target object to compare with.
   * @param {Array} properties List of properties to be chacked.
   * @returns {Boolean} Returns true if the properties have been altered.
   */
  Model.propertiesChanged = function(source, target, properties) {
    debug('comparing source %o with target %o in properties %o', source, target, properties);

    var changed = false;
    _.forEach(properties, function(key) {
      debug('checking property %s ', key);
      if (target[key]) {
        if (!source[key] || target[key] !== source[key]) {
          changed = true;
        }
      }
    });
    if (changed) {
      debug('propertiesChanged: properties were changed');
    }
    return changed;
  };

  Model.getChangedProperties = function(oldVals, newVals, properties) {
    debug('getChangedProperties: comparing oldVals %o with newVals %o in properties %o', oldVals, newVals, properties);

    var itemId = oldVals[Model.getIdName()];
    var changedProperties = {};
    changedProperties[itemId] = {};

    _.forEach(properties, function(key) {
      debug('getChangedProperties: - checking property %s ', key);

      if (newVals[key]) {
        var newVal = newVals[key];
        debug('getChangedProperties:   - new value %s ', newVal);

        if (!oldVals[key] || newVal !== oldVals[key]) {
          debug('getChangedProperties:   - changed or new value %s itemId %s', newVal, itemId);

          changedProperties[itemId][key] = newVal;
        }
      }
    });
    if (!_.isEmpty(changedProperties[itemId])) {
      debug('getChangedProperties: Properties were changed %o', changedProperties);
      return changedProperties;
    }
    return false;
  };

  Model.extractChangedItemIds = function(items) {
    return _.pluck(items, Model.getIdName());
  };

}

module.exports = function mixin(app) {
  app.loopback.modelBuilder.mixins.define('Changed', changed);
};
