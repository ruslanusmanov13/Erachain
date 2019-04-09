package org.erachain.gui.items;

import org.erachain.controller.Controller;
import org.erachain.core.item.ItemCls;
import org.erachain.database.SortableList;
import org.erachain.database.wallet.FavoriteItemMap;
import org.erachain.datachain.DCMap;
import org.erachain.datachain.ItemMap;
import org.erachain.gui.models.SortedListTableModelCls;
import org.erachain.utils.ObserverMessage;
import org.erachain.utils.Pair;

import java.util.*;

@SuppressWarnings("serial")
public abstract class FavoriteItemModelTable extends SortedListTableModelCls<Long, ItemCls> implements Observer {

    private final int RESET_EVENT;
    private final int ADD_EVENT;
    private final int DELETE_EVENT;
    private final int LIST_EVENT;

    protected FavoriteItemMap favoriteMap;

    public FavoriteItemModelTable(DCMap map, FavoriteItemMap favoriteMap, String[] columnNames, Boolean[] columnAutoHeight,
                                  int resetObserver, int addObserver, int deleteObserver, int listObserver, int favorite) {
        super(columnNames, columnAutoHeight, false);

        // в головной гласс нельзя таблицу передавать - чтобы там лишний раз не запускалась иницализация наблюдения
        // оно еще ен готово так как таблица вторая не присвоена - ниже привяжемся к наблюдениям
        this.map = map;
        this.favoriteMap = favoriteMap;
        COLUMN_FAVORITE = favorite;

        RESET_EVENT = resetObserver;
        ADD_EVENT = addObserver;
        DELETE_EVENT = deleteObserver;
        LIST_EVENT = listObserver;

        // теперь нужно опять послать событие чтобы загрузить
        getInterval();
        fireTableDataChanged();
        needUpdate = false;

        // переиницализация после установуи таблиц
        this.addObservers();

    }

    @SuppressWarnings("unchecked")
    public synchronized void syncUpdate(Observable o, Object arg) {
        ObserverMessage message = (ObserverMessage) arg;

        //CHECK IF NEW LIST
        int type = message.getType();
        if (type == LIST_EVENT) {
            getInterval();
            fireTableDataChanged();
            needUpdate = false;

        } else if (type == ADD_EVENT) {
            list.add(Controller.getInstance().getAsset((long) message.getValue()));
            needUpdate = true;

        } else if (type == DELETE_EVENT) {
            list.remove(Controller.getInstance().getAsset((long) message.getValue()));
            needUpdate = true;

        } else if (type == RESET_EVENT) {
            getInterval();
            fireTableDataChanged();
            needUpdate = false;
        }
    }

    // необходимо переопределить так у супер класса по размеру SortedList
    // а нам надо по Лист
    @Override
    public int getRowCount() {
        if (list == null) {
            return 0;
        }

        return list.size();
    }

    //public abstract int getMapSize();
    @Override
    public long getMapSize() {
        return favoriteMap.size();
    }

    @Override
    public void getInterval() {

        getIntervalThis( start, step);

    }

    @Override
    public void getIntervalThis(long startBack, long endBack) {
        listSorted = new SortableList<Long, ItemCls>(map, favoriteMap.getFromToKeys(0, 999999999));
        listSorted.sort();

        list = new ArrayList<>();
        for (Pair<Long, ItemCls> key: listSorted) {
            if (key.getB() == null) {
                continue;
            }
            list.add((ItemCls)map.get(key.getA()));
        }

    }

    public void addObservers() {
        if (Controller.getInstance().doesWalletDatabaseExists()
            && favoriteMap != null)
            favoriteMap.addObserver(this);
    }

    public void deleteObservers() {
        if (Controller.getInstance().doesWalletDatabaseExists()
                && favoriteMap != null)
            favoriteMap.deleteObserver(this);
    }

}