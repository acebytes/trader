/* Dependencies */
var moment = require('moment');

var Sheet = require('./lib/sheet');
var Trader = require('./lib/trader');
var Boot = require('./lib/boot');
var Order = require('./lib/order');
var Bitfinex = require('./lib/bitfinex');


/**
 * Instanciate helpers
 */
var fees = {
    maker: 0.001,
    taker: 0.002
};
var boot = new Boot();
var trader = new Trader(fees);
var bitfinex = new Bitfinex(logTradePrices, logOrderUpdate);
var sheet = new Sheet(process.env.DRIVE_SHEET, process.env.DRIVE_CREDS);


/**
 * Main datastructure recording state
 */
var data = {
    balanceUSD: 0,
    balanceBTC: 0,
    lastBuy: null,
    lastSell: null
};
var minTradeBTC = 0.01;
var updatingBalances = false;
var makingOrder = false;


boot.init(bitfinex, sheet, function (accountData, traderData, feesData)
{
    if (accountData) data = accountData;
    if (feesData) fees = feesData;
    if (traderData && traderData.highestSupportZone > 0)
    {
        try
        {
            var sz = parseFloat(traderData.highestSupportZone);
            if (!isNaN(sz) && sz > 0) trader.highestSupportZone = sz;
        }
        catch (e)
        {}
    }

    if (!updatingBalances) checkShouldSell(data.lastBuy);

    bitfinex.start();
});

/**
 * Bitfinex socket listeners
 */
function logTradePrices(tradePrice)
{
    trader.inboundTrade(tradePrice);
    checkShouldBuy(tradePrice);
    logCurrentUpdates();
}

function logOrderUpdate(order)
{
    if (data.lastBuy && order.id === data.lastBuy.id)
    {
        if (order.status !== 'EXECUTED') return;
        if (data.lastBuy.status === 'ACTIVE')
        {
            data.lastBuy = order;
            logOrder(order);
        }
    }
    else if (data.lastSell && order.id === data.lastSell.id)
    {
        if (order.status !== 'EXECUTED') return;
        if (data.lastSell.status === 'ACTIVE')
        {
            data.lastSell = order;
            logOrder(order);
        }
    }
    else return;

    checkShouldSell(data.lastBuy);
}


/**
 * Check the trader to find out if we should buy or sell
 */
function checkShouldSell(lastBuy)
{
    // If there is already an active order, exit
    if (hasActiveOrder()) return;

    updateBalances(function ()
    {
        // If you don't have any BTC in wallet, exit
        if (data.balanceBTC === 0) return;

        // If you don't have enough BTC to meet the min order amount on bitfinex, exit
        if (data.balanceBTC < minTradeBTC) return;

        // If you're already currently making an order, exit
        // basically a thread lock
        if (makingOrder) return;

        makingOrder = true;

        var sellPrice = trader.resistanceZone(data.lastBuy.price);
        var orderData = trader.sellOrder(sellPrice, data.balanceBTC);
        bitfinex.rest.new_order(
            orderData.symbol,
            orderData.amount,
            orderData.price,
            orderData.exchange,
            orderData.side,
            orderData.type,
            madeOrderCallback);
    });
}

function checkShouldBuy(currentTicker)
{
    // If there i already an active order, exit
    if (hasActiveOrder()) return;

    // If you don't have any USD in wallet, exit
    if (data.balanceUSD === 0) return;

    // If you don't have enough USD to meet the min order amount on bitfinex, exit
    if (data.balanceUSD < (minTradeBTC * currentTicker)) return;

    // If it's not the time to buy according to the trader, exit
    if (!trader.timeToBuy(currentTicker)) return;

    // If you're already currently making an order, exit
    // basically a thread lock
    if (makingOrder) return;

    makingOrder = true;
    var orderData = trader.buyOrder(currentTicker, data.balanceUSD);
    bitfinex.rest.new_order(
        orderData.symbol,
        orderData.amount,
        orderData.price,
        orderData.exchange,
        orderData.side,
        orderData.type,
        madeOrderCallback);
}

/**
 * Utility to log what the trader is thinking
 * for debugging purposes for now
 */
var lastResistanceZone = -1;
var lastSupportZone = -1;

function logCurrentUpdates()
{
    var currentData = JSON.parse(JSON.stringify(data));

    currentData.supportZone = 0;
    if (trader.highestSupportZone)
    {
        var sz = parseFloat(trader.highestSupportZone);
        if (!isNaN(sz) && sz > 0) currentData.supportZone = sz;
    }

    currentData.resistanceZone = 0;
    if (data.lastBuy)
    {
        currentData.resistanceZone = trader.resistanceZone(data.lastBuy.price);
    }

    if (currentData.resistanceZone === lastResistanceZone &&
        currentData.supportZone === lastSupportZone) return;

    delete currentData.lastBuy;
    delete currentData.lastSell;

    lastResistanceZone = currentData.resistanceZone;
    lastSupportZone = currentData.supportZone;

    currentData.time = moment().format('MM/DD HH:mm:ss');

    sheet.recordTraderData(currentData).catch(function (err)
    {
        console.log("Could not record trader data");
        console.log(err);
    });
}

/**
 * Utility to check whether there is an active order
 */
function hasActiveOrder()
{
    // If there i already an active order, exit
    if (data.lastBuy && data.lastBuy.status === 'ACTIVE') return true;
    if (data.lastSell && data.lastSell.status === 'ACTIVE') return true;

    return false;
}

/**
 * Callback to handle new order creation
 */
function madeOrderCallback(err, res)
{
    makingOrder = false;
    if (err)
    {
        console.log("Could not place order");
        return console.log(err);
    }

    // Set all balances to 0 since the current order is active
    data.balanceBTC = 0;
    data.balanceUSD = 0;

    // Log to active order to google sheets
    logOrder(new Order.fromRestA(res));
}

/**
 * Utility to log an order/trade to google sheets
 */
function logOrder(order)
{
    var prettyOrder = order.sheetsFormat();
    if (!prettyOrder) return;
    sheet.recordMyTrade(prettyOrder).catch(function (err)
    {
        console.log("Could not record order to drive sheets");
        console.log(err);
    });
}

/**
 * Utility to get wallet balances
 */
function updateBalances(callback)
{
    bitfinex.getUpdatedBalances(function (balances)
    {
        if (balances)
        {
            data.balanceBTC = balances.balanceBTC;
            data.balanceUSD = balances.balanceUSD;
        }
        callback();
    });
}
