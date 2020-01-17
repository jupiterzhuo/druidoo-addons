odoo.define('pos_voucher.pos_voucher', function (require) {
"use strict";

var core = require('web.core');
var gui = require('point_of_sale.gui');
var screens = require('point_of_sale.screens');
var models = require('point_of_sale.models');
var PopupWidget = require('point_of_sale.popups');
var rpc = require('web.rpc');
var _t = core._t;
models.load_fields("account.bank.statement", ['is_voucher']);

    models.load_models({
        model: 'pos.voucher',
        fields: ['code', 'type_id', 'partner_id', 'start_date', 'end_date','pending_amount','total_amount'],
        domain: [['state', 'in', ['validated','partially_consumed']]],
        context: {'pos': true},
        loaded: function (self, vouchers) {
            self.vouchers = vouchers;
            self.voucher_by_id = {};
            self.voucher_by_customer = {};
            for (var x = 0; x < vouchers.length; x++) {
                self.voucher_by_id[vouchers[x].id] = vouchers[x];
                if (!self.voucher_by_customer[vouchers[x].partner_id[0]]) {
                    self.voucher_by_customer[vouchers[x].partner_id[0]] = [vouchers[x]];
                }
                else{
                    self.voucher_by_customer[vouchers[x].partner_id[0]].push(vouchers[x]);
                }
            }
        }
    });

    models.load_models({
        model: 'pos.voucher.type',
        fields: ['name', 'journal_id'],
        domain: [],
        context: {'pos': true},
        loaded: function (self, vouchers_type) {
            self.vouchers_type = vouchers_type;
            self.voucher_type_by_id = {};
            for (var x = 0; x < vouchers_type.length; x++) {
                self.voucher_type_by_id[vouchers_type[x].id] = vouchers_type[x];
            }
        }
    });

    var _super_Order = models.Order.prototype;
    models.Order = models.Order.extend({
        export_as_JSON: function () {
            var json = _super_Order.export_as_JSON.apply(this, arguments);
            if (this.voucher_id) {
                json.voucher_id = parseInt(this.voucher_id);
            }
            return json;
        },
    });

    var alert_input = PopupWidget.extend({
        template: 'alert_input',
        show: function (options) {
            options = options || {};
            this._super(options);
            this.renderElement();
            this.$('input').focus();
        },
        click_confirm: function () {
            var value = this.$('input').val();
            this.gui.close_popup();
            if (this.options.confirm) {
                this.options.confirm.call(this, value);
            }
        },
    });
    gui.define_popup({name: 'alert_input', widget: alert_input});
    
    screens.PaymentScreenWidget.include({
        renderElement: function () {
            var self = this;
            this._super();
            this.$('.customer_vouchers').click(function(){
                self.pos.gui.show_screen('voucherlist');
            });
            this.$('.voucher_redeem').click(function () { // input manual voucher
                self.hide();
                return self.pos.gui.show_popup('alert_input', {
                    title: _t('Voucher'),
                    body: _t('Please input code of a voucher.'),
                    confirm: function (code) {
                        self.show();
                        self.renderElement();
                        if (!code) {
                            return false;
                        } else {
                            var current_order = self.pos.get('selectedOrder');
                            var partner_id = false;
                            if (current_order.get_client()){
                                var partner_id = current_order.get_client().id;
                                }
                            return rpc.query({
                                model: 'pos.voucher',
                                method: 'get_voucher_by_code',
                                args: [code, partner_id],
                            }).then(function (voucher) {
                                if (voucher[0] == -1) {
                                    return self.gui.show_popup('confirm', {
                                        title: 'Warning',
                                        body: voucher[1],
                                    });
                                } else {
                                    voucher = voucher[1]
                                    current_order.voucher_id = voucher.id;
                                    var voucher_register = null;
                                    if (voucher.type_id)
                                    {
                                        var voucher_type_search = self.pos.voucher_type_by_id[voucher.type_id[0]];
                                        if(voucher_type_search)
                                        {
                                            voucher_register = _.find(self.pos.cashregisters, function (cashregister) {
                                                return cashregister.journal['id'] == voucher_type_search['journal_id'][0];
                                            });
                                        }
                                    }
                                    if (!voucher_register){
                                        return self.gui.show_popup('alert', {
                                                    title: _t('Configuration Warning'),
                                                    body: _t('Please configure '+ voucher_type_search['journal_id'][1] + ' as a payment method in your POS.'),
                                                });

                                    }
                                    if (voucher['partner_id'] && voucher['partner_id'][0]) {
                                        var client = self.pos.db.get_partner_by_id(voucher['partner_id'][0]);
                                        if (client) {
                                            current_order.set_client(client)
                                        }
                                    }
                                    var amount = voucher.pending_amount;
                                    
                                    var paymentlines = current_order.paymentlines;
                                    for (var i = 0; i < paymentlines.models.length; i++) {
                                        var payment_line = paymentlines.models[i];
                                        if (payment_line.cashregister.journal['id'] == voucher_register['journal'].id) {
                                            payment_line.destroy();
                                        }
                                    }
                                    var voucher_paymentline = new models.Paymentline({}, {
                                        order: current_order,
                                        cashregister: voucher_register,
                                        pos: self.pos
                                    });
                                    var due = current_order.get_due();
                                    if (amount >= due) {
                                        voucher_paymentline.set_amount(due);
                                    } else {
                                        voucher_paymentline.set_amount(amount);
                                    }
                                    voucher_paymentline['voucher_id'] = voucher['id'];
                                    voucher_paymentline['voucher_code'] = voucher['code'];
                                    current_order.paymentlines.add(voucher_paymentline);
                                    current_order.trigger('change', current_order);
                                    self.render_paymentlines();
                                    self.$('.paymentline.selected .edit').text(self.format_currency_no_symbol(amount));
                                }
                            }).fail(function (type, error) {
                                return self.pos.query_backend_fail(type, error);
                            });
                        }
                    },
                    cancel: function () {
                        self.show();
                        self.renderElement();
                    }
                });
            });
        },

        render_paymentlines: function () {
            this._super();
            var voucher_journal = _.find(this.pos.cashregisters, function (cashregister) {
                return cashregister.journal['pos_method_type'] == 'voucher';
            });
            if (voucher_journal) {
                var voucher_journal_id = voucher_journal.journal.id;
                var voucher_journal_content = $("[data-id='" + voucher_journal_id + "']");
                voucher_journal_content.addClass('oe_hidden');
            }
        },

        validate_order: function(force_validation) {
            var current_order = this.pos.get_order();
            if (current_order.is_paid() && current_order.voucher_id) {
                var voucher = this.pos.voucher_by_id[current_order.voucher_id];
                if (voucher)
                {
                    if (current_order.get_client())
                    {
                        var voucher_type_search = this.pos.voucher_type_by_id[voucher.type_id[0]];
                        var voucher_amount = 0;
                        var paymentlines = current_order.paymentlines;
                        for (var i = 0; i < paymentlines.models.length; i++) {
                            var payment_line = paymentlines.models[i];
                            if (payment_line.cashregister.journal['id'] == voucher_type_search['journal_id'][0]) {
                                if (payment_line.amount > this.pos.voucher_by_id[current_order.voucher_id].pending_amount)
                                {
                                    return this.gui.show_popup('alert', {
                                                title: _t('Configuration Warning'),
                                                body: _t('The amount of ' + voucher_type_search['journal_id'][1] + ' must be less than a voucher amount!'),
                                            });
                                }
                                voucher_amount = payment_line.amount
                            }
                        }
                        this.pos.voucher_by_customer[current_order.get_client().id].pending_amount -= voucher_amount;
                        this.pos.voucher_by_id[current_order.voucher_id].pending_amount -= voucher_amount;
                        if (this.gui.screen_instances['voucherlist'])
                        {
                            this.gui.screen_instances['voucherlist'].voucher_cache.clear_node(voucher.id);
                        }
                    }
                }
            }
            this._super(force_validation);
        },
    });

    screens.ClientListScreenWidget.include({
        has_client_changed: function(){
            var current_order = this.pos.get('selectedOrder');
            var paymentlines = current_order.paymentlines;
            for (var i = 0; i < paymentlines.models.length; i++) {
                var payment_line = paymentlines.models[i];
                payment_line.destroy();
            }
            return this._super();
        },
    });
});