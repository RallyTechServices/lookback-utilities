Ext.define("lookback-test", {
    extend: 'Rally.app.App',
    componentCls: 'app',
    logger: new Rally.technicalservices.Logger(),

    integrationHeaders : {
        name : "lookback-test"
    },

    hydrateFields: ['State','ScheduleState'],
    requiredFetch: ['ObjectID','FormattedID','LastUpdateDate'],

    launch: function() {
        this.addComponents();
        //this.compareSnaps();
    },
    addComponents: function(){
        var filters = Rally.data.wsapi.Filter.or([{
            property: 'TypePath',
            operator: 'contains',
            value: 'PortfolioItem/'
        },{
            property: 'TypePath',
            value: 'HierarchicalRequirement'
        },{
            property: 'TypePath',
            value: 'Defect'
        },{
            property: 'TypePath',
            value:'Task'
        }]);

        var def = {
            margin: 5,
            labelAlign: 'right',
            labelWidth: 150,
            width: 300
        };

        var modelPicker = this.add(Ext.apply({
            xtype: 'rallycombobox',
            storeConfig: {
                model: 'TypeDefinition',
                fetch: ['TypePath','DisplayName'],
                filters: filters,
                remoteFilter: true,
                autoLoad: true
            },
            itemId: 'modelPicker',
            fieldLabel: 'Artifact Type',
            valueField: 'TypePath',
            displayField: 'DisplayName'
        },def));

        var fieldPicker = this.add(Ext.apply({
            xtype: 'rallyfieldcombobox',
            multiSelect: true,
            itemId: 'fieldPicker',
            fieldLabel: 'Fields to Compare',
            context: this.getContext()
        },def));
        modelPicker.on('select', this.updateFieldPicker, this);
        modelPicker.on('ready', this.updateFieldPicker, this);

        this.add(Ext.apply({
            xtype: 'rallydatefield',
            maxValue: new Date(),
            value: Rally.util.DateTime.add(new Date(), 'day',-30),
            fieldLabel: 'Last Updated After'
        },def));

        this.add({
            xtype: 'rallybutton',
            text: 'Compare',
            listeners: {
                scope: this,
                click: this.compareSnaps
            },
            margin: '5 160 5 160'
        });

        this.add({
            xtype: 'container',
            itemId: 'displayBox',
            tpl: '<div class="no-data-container"><div class="secondary-message">{message}</div></div>'
        });
    },

    updateFieldPicker: function(){

        var cb = this.down('#modelPicker');

        if (cb && cb.getValue() && this.down('#fieldPicker')){
            this.down('#fieldPicker').refreshWithNewModelType(cb.getValue());
        }

    },
    compareSnaps: function(){
        this.setLoading(true);
        this.down('#displayBox').update({message: 'Fetching data...'});
        Deft.Promise.all([
            this.fetchWsapiRecords({
                model: this.getObjectType(),
                fetch: this.getObjectFetch(),
                filters: this.getObjectFilters(),
                pageSize: 2000,
                limit: Infinity
            }),
            this.fetchSnapshots({
                find: {
                    _TypeHierarchy: this.getObjectType(),
                    __At: "current",
                    _ProjectHierarchy: this.getContext().getProject().ObjectID
                },
                removeUnauthorizedSnapshots: true,
                limit: Infinity,
                fetch: this.getSnapshotFetch(),
                hydrate: this.getHydrate()
            })
        ]).then({
            success: this.showResults,
            failure: this.showError,
            scope: this
        }).always(function(){ this.setLoading(false); }, this);
    },
    showResults: function(results){
        var wsapiResults = results[0],
            snapshots = results[1],
            hash = {};

        this.logger.log('showResults', wsapiResults, snapshots);


        for (var i=0; i<wsapiResults.length; i++){
            hash[wsapiResults[i].get('ObjectID')] = {wsapi: wsapiResults[i].getData(), lookback: null};
        }

        for (var i=0; i<snapshots.length; i++){
            var snap = snapshots[i];
            if (hash[snap.get('ObjectID')]){
                hash[snap.get('ObjectID')].lookback = snap.getData();
            }
        }

        this.logger.log('showResults hash', hash);

        var csv = [],
            fields = this.getExtraFields();
        var headers = ['Issue','ObjectID','FormattedID', 'Wsapi LastUpdateDate','Snapshot _ValidFrom'];
        Ext.Array.each(fields, function(f){
            headers.push('Wsapi ' + f);
            headers.push('Snapshot ' + f);
        });

        csv.push(headers.join(','));
        Ext.Object.each(hash, function(objID, obj){
            var row = [];
            if (obj.wsapi && !obj.lookback){
                row = ['No current snapshot',objID, obj.wsapi.FormattedID, obj.wsapi.LastUpdateDate];
                this.logger.log('No current snapshot',objID, obj.wsapi.FormattedID, obj.wsapi.LastUpdateDate);
            } else {
                var mismatch = false;
                Ext.Array.each(fields, function(f){
                    var wsVal = obj.wsapi[f],
                        snapVal = obj.lookback[f];

                    wsVal = wsVal && wsVal._refObjectName || wsVal;
                    snapVal = snapVal && snapVal._refObjectName || snapVal;

                    if (wsVal != snapVal && wsVal !== null && snapVal !== 0){
                        mismatch = true;
                        return false;
                    }
                });
                if (mismatch){
                    row = ['current snapshot values do not match wsapi', objID, obj.wsapi.FormattedID, obj.wsapi.LastUpdateDate, obj.lookback._ValidFrom];
                    Ext.Array.each(fields, function(f){
                        var wsVal = obj.wsapi[f];
                        row.push(wsVal && wsVal._refObjectName || wsVal);

                        var snapVal = obj.lookback[f];
                        row.push(snapVal && snapVal._refObjectName || snapVal);
                    });
                }
            }
            if (row.length > 0){
                csv.push(row.join(','));
            }
        }, this);
        if (csv.length > 1){
            this.down('#displayBox').update({message: Ext.String.format("{0} conflicts / {1} records found.",csv.length - 1,wsapiResults.length)});
            csv = csv.join('\r\n');
            CArABU.technicalservices.FileUtilities.saveCSVToFile(csv,Ext.String.format('lookback-{0}-{1}.csv', this.getObjectType().replace('/',''), Rally.util.DateTime.format(new Date(), 'Y-m-d')));
        } else {
            this.down('#displayBox').update({message: 'No conflicts found.'});
        }


    },
    showError: function(errorMsg){
        this.down('#displayBox').update({message: errorMsg});
        Rally.ui.notify.Notifier.showError({message: errorMsg});
    },
    fetchWsapiRecords: function(config){
        var deferred = Ext.create('Deft.Deferred');
        this.logger.log('fetchWsapiRecords', config);
        Ext.create('Rally.data.wsapi.Store',config).load({
            callback: function(records, operation){

                if (operation.wasSuccessful()){
                    deferred.resolve(records);
                } else {
                    deferred.reject('Wsapi call failed: ' + operation.error.errors.join(','));
                }
            }
        });

        return deferred;
    },
    fetchSnapshots: function(config){
        var deferred = Ext.create('Deft.Deferred');
        this.logger.log('fetchSnapshots', config);
        Ext.create('Rally.data.lookback.SnapshotStore',config).load({
            callback: function(records, operation){

                if (operation.wasSuccessful()){
                    deferred.resolve(records);
                } else {
                    deferred.reject('Lookback call failed: ' + operation.error.errors.join(','));
                }
            }
        });

        return deferred;
    },
    getHydrate: function(){
        return Ext.Array.intersect(this.getExtraFields(), this.hydrateFields);
    },
    getObjectType: function(){
        return this.down('#modelPicker') && this.down('#modelPicker').getValue();
    },
    getExtraFields: function(){
        return this.down('#fieldPicker') && this.down('#fieldPicker').getValue();
    },
    getObjectFetch: function(){
       return this.requiredFetch.concat(this.getExtraFields());
    },
    getSnapshotFetch: function(){
        return this.getObjectFetch().concat(['_ValidFrom']);
    },
    getAfterDate: function(){
        return this.down('rallydatefield') && this.down('rallydatefield').getValue();
    },
    getObjectFilters: function(){
        if (this.getAfterDate()){
            return [{
                property: 'LastUpdateDate',
                operator: '>',
                value: this.getAfterDate()
            }];
        } else {
            return [];
        }
    },
    getOptions: function() {
        return [
            {
                text: 'About...',
                handler: this._launchInfo,
                scope: this
            }
        ];
    },
    
    _launchInfo: function() {
        if ( this.about_dialog ) { this.about_dialog.destroy(); }
        this.about_dialog = Ext.create('Rally.technicalservices.InfoLink',{});
    },
    
    isExternal: function(){
        return typeof(this.getAppId()) == 'undefined';
    },
    
    //onSettingsUpdate:  Override
    onSettingsUpdate: function (settings){
        this.logger.log('onSettingsUpdate',settings);
        // Ext.apply(this, settings);
        this.launch();
    }
});
